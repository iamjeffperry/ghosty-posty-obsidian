import { requestUrl, RequestUrlResponse } from 'obsidian';
import { GhostPostPayload, GhostPostResponse, GhostPostResult, GhostSiteResponse, GhostErrorResponse, GhostImageUploadResponse, GhostNewslettersResponse, GhostNewsletter } from './types';

/** Options controlling how a create/update is delivered. */
export interface PublishOptions {
    /** When set, the post is also sent to this newsletter (by slug). */
    newsletterSlug?: string;
}

/** A successful result carrying the affected post, or a failure with a message. */
export type PostResult =
    | { success: true; post: GhostPostResult }
    | { success: false; error: string };

/**
 * Convert a hex string to Uint8Array
 */
function hexToBytes(hex: string) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
}

/**
 * Base64url encode (URL-safe base64 without padding)
 */
function base64UrlEncode(data: Uint8Array | string): string {
    let base64: string;
    if (typeof data === 'string') {
        base64 = btoa(data);
    } else {
        // Convert Uint8Array to string then base64
        let binary = '';
        for (let i = 0; i < data.length; i++) {
            binary += String.fromCharCode(data[i]);
        }
        base64 = btoa(binary);
    }
    // Convert to base64url
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate a Ghost Admin API JWT token using Web Crypto API
 * This is mobile-compatible (no Node.js crypto dependency)
 */
async function generateGhostToken(apiKey: string): Promise<string> {
    // Split the API key into ID and secret
    const [id, secret] = apiKey.split(':');

    if (!id || !secret) {
        throw new Error('Invalid API key format. Expected format: id:secret');
    }

    // Create JWT header
    const header = {
        alg: 'HS256',
        typ: 'JWT',
        kid: id
    };

    // Create JWT payload
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        iat: now,
        exp: now + 300, // 5 minutes expiration
        aud: '/admin/'
    };

    // Encode header and payload
    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    const signatureInput = `${encodedHeader}.${encodedPayload}`;

    // Convert hex secret to bytes
    const secretBytes = hexToBytes(secret);

    // Import the key for HMAC-SHA256
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        secretBytes,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );

    // Sign the input
    const signatureBuffer = await crypto.subtle.sign(
        'HMAC',
        cryptoKey,
        new TextEncoder().encode(signatureInput)
    );

    // Encode signature
    const signature = base64UrlEncode(new Uint8Array(signatureBuffer));

    return `${signatureInput}.${signature}`;
}

export class GhostAPI {
    private ghostUrl: string;
    private apiKey: string;

    constructor(ghostUrl: string, apiKey: string) {
        // Normalize URL - remove trailing slash
        this.ghostUrl = ghostUrl.replace(/\/+$/, '');
        this.apiKey = apiKey;
    }

    /**
     * Get the authorization header with JWT token
     */
    private async getAuthHeader(): Promise<string> {
        const token = await generateGhostToken(this.apiKey);
        return `Ghost ${token}`;
    }

    /**
     * Make an API request to Ghost
     */
    private async request(
        method: 'GET' | 'POST' | 'PUT' | 'DELETE',
        endpoint: string,
        body?: object
    ): Promise<RequestUrlResponse> {
        const token = await this.getAuthHeader();
        const url = `${this.ghostUrl}/ghost/api/admin${endpoint}`;

        const options: Parameters<typeof requestUrl>[0] = {
            url,
            method,
            headers: {
                'Authorization': token,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        };

        if (body) {
            options.body = JSON.stringify(body);
        }

        return requestUrl(options);
    }

    /**
     * Test the connection to Ghost
     * Returns the site info if successful
     */
    async testConnection(): Promise<{ success: true; siteName: string } | { success: false; error: string }> {
        try {
            const response = await this.request('GET', '/site/');

            if (response.status >= 200 && response.status < 300) {
                const data = response.json as GhostSiteResponse;
                return {
                    success: true,
                    siteName: data.site?.title || 'Unknown Site'
                };
            } else {
                const errorData = response.json as GhostErrorResponse;
                return {
                    success: false,
                    error: errorData.errors?.[0]?.message || `HTTP ${response.status}`
                };
            }
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    /**
     * Build the query string for a create/update, wiring up the source format
     * and (optionally) a newsletter send.
     */
    private buildPostQuery(options?: PublishOptions): string {
        const params = new URLSearchParams();
        // Use source=html to let Ghost convert our HTML to its internal format
        params.set('source', 'html');
        if (options?.newsletterSlug) {
            params.set('newsletter', options.newsletterSlug);
        }
        return `?${params.toString()}`;
    }

    /**
     * Create a new post on Ghost
     */
    async createPost(payload: GhostPostPayload, options?: PublishOptions): Promise<PostResult> {
        try {
            const response = await this.request('POST', `/posts/${this.buildPostQuery(options)}`, payload);
            return this.parsePostResponse(response);
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    /**
     * Update an existing post on Ghost. The payload's post MUST include the
     * current `updated_at` (from getPost) so Ghost can detect collisions.
     */
    async updatePost(id: string, payload: GhostPostPayload, options?: PublishOptions): Promise<PostResult> {
        try {
            const response = await this.request('PUT', `/posts/${id}/${this.buildPostQuery(options)}`, payload);
            return this.parsePostResponse(response);
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    /**
     * Fetch a single post by id, including its rendered HTML content.
     */
    async getPost(id: string): Promise<PostResult> {
        try {
            const response = await this.request('GET', `/posts/${id}/?formats=html`);
            return this.parsePostResponse(response);
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    /**
     * List the site's active newsletters (for the delivery picker).
     * Returns an empty list on failure so callers can degrade gracefully.
     */
    async getNewsletters(): Promise<GhostNewsletter[]> {
        try {
            const response = await this.request('GET', '/newsletters/?filter=status:active&limit=all');
            if (response.status >= 200 && response.status < 300) {
                const data = response.json as GhostNewslettersResponse;
                return data.newsletters ?? [];
            }
            return [];
        } catch {
            return [];
        }
    }

    /**
     * Parse a Ghost posts response into a PostResult.
     */
    private parsePostResponse(response: RequestUrlResponse): PostResult {
        if (response.status >= 200 && response.status < 300) {
            const data = response.json as GhostPostResponse;
            const post = data.posts?.[0];
            if (!post) {
                return { success: false, error: 'Ghost returned no post data' };
            }
            return { success: true, post };
        }
        const errorData = response.json as GhostErrorResponse;
        return {
            success: false,
            error: errorData.errors?.[0]?.message || `HTTP ${response.status}`
        };
    }

    /**
     * Upload an image to Ghost
     */
    async uploadImage(filename: string, imageData: ArrayBuffer): Promise<{ success: true; url: string } | { success: false; error: string }> {
        try {
            const token = await this.getAuthHeader();
            const url = `${this.ghostUrl}/ghost/api/admin/images/upload/`;

            // Determine content type from filename
            const ext = filename.split('.').pop()?.toLowerCase() || '';
            const mimeTypes: Record<string, string> = {
                'jpg': 'image/jpeg',
                'jpeg': 'image/jpeg',
                'png': 'image/png',
                'gif': 'image/gif',
                'webp': 'image/webp',
                'svg': 'image/svg+xml'
            };
            const contentType = mimeTypes[ext] || 'application/octet-stream';

            // Create multipart form data manually
            const boundary = '----GhostyPostyBoundary' + Math.random().toString(36).substring(2);

            // Build the multipart body
            const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`;
            const footer = `\r\n--${boundary}--\r\n`;

            // Convert header and footer to Uint8Array
            const headerBytes = new TextEncoder().encode(header);
            const footerBytes = new TextEncoder().encode(footer);
            const imageBytes = new Uint8Array(imageData);

            // Combine all parts
            const body = new Uint8Array(headerBytes.length + imageBytes.length + footerBytes.length);
            body.set(headerBytes, 0);
            body.set(imageBytes, headerBytes.length);
            body.set(footerBytes, headerBytes.length + imageBytes.length);

            const response = await requestUrl({
                url,
                method: 'POST',
                headers: {
                    'Authorization': token,
                    'Content-Type': `multipart/form-data; boundary=${boundary}`
                },
                body: body.buffer
            });

            if (response.status >= 200 && response.status < 300) {
                const data = response.json as GhostImageUploadResponse;
                if (data.images && data.images.length > 0) {
                    return {
                        success: true,
                        url: data.images[0].url
                    };
                } else {
                    return {
                        success: false,
                        error: 'No image URL returned from Ghost'
                    };
                }
            } else {
                const errorData = response.json as GhostErrorResponse;
                return {
                    success: false,
                    error: errorData.errors?.[0]?.message || `HTTP ${response.status}`
                };
            }
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }
}
