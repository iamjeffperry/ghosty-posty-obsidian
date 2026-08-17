import { requestUrl, RequestUrlResponse } from 'obsidian';
import {
    GhostPostPayload,
    GhostPostResponse,
    GhostPostResult,
    GhostSiteResponse,
    GhostErrorResponse,
    GhostImageUploadResponse,
    GhostNewslettersResponse,
    GhostNewsletter
} from './types';

/** Options controlling how a create/update is delivered. */
export interface PublishOptions {
    /** When set, the post is also sent to this newsletter (by slug). */
    newsletterSlug?: string;
}

/** A successful result carrying the affected post, or a failure with a message. */
export type PostResult =
    | { success: true; post: GhostPostResult }
    | { success: false; error: string };

/** Result returned when requesting bookmark metadata from Ghost. */
export type BookmarkResult =
    | { success: true; data: Record<string, unknown> }
    | { success: false; error: string };

/**
 * Convert a hex string to Uint8Array.
 */
function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);

    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }

    return bytes;
}

/**
 * Base64url encode (URL-safe base64 without padding).
 */
function base64UrlEncode(data: Uint8Array | string): string {
    let base64: string;

    if (typeof data === 'string') {
        base64 = btoa(data);
    } else {
        let binary = '';

        for (let i = 0; i < data.length; i++) {
            binary += String.fromCharCode(data[i]);
        }

        base64 = btoa(binary);
    }

    return base64
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * Generate a Ghost Admin API JWT token using Web Crypto API.
 * This is mobile-compatible and does not rely on Node.js crypto.
 */
async function generateGhostToken(apiKey: string): Promise<string> {
    const [id, secret] = apiKey.split(':');

    if (!id || !secret) {
        throw new Error('Invalid API key format. Expected format: id:secret');
    }

    const header = {
        alg: 'HS256',
        typ: 'JWT',
        kid: id
    };

    const now = Math.floor(Date.now() / 1000);

    const payload = {
        iat: now,
        exp: now + 300,
        aud: '/admin/'
    };

    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));

    const signatureInput = `${encodedHeader}.${encodedPayload}`;

    const secretBytes = hexToBytes(secret);

    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        secretBytes,
        {
            name: 'HMAC',
            hash: 'SHA-256'
        },
        false,
        ['sign']
    );

    const signatureBuffer = await crypto.subtle.sign(
        'HMAC',
        cryptoKey,
        new TextEncoder().encode(signatureInput)
    );

    const signature = base64UrlEncode(
        new Uint8Array(signatureBuffer)
    );

    return `${signatureInput}.${signature}`;
}

export class GhostAPI {
    private ghostUrl: string;
    private apiKey: string;

    constructor(ghostUrl: string, apiKey: string) {
        // Normalize URL - remove trailing slash.
        this.ghostUrl = ghostUrl.replace(/\/+$/, '');
        this.apiKey = apiKey;
    }

    /**
     * Get the authorization header with JWT token.
     */
    private async getAuthHeader(): Promise<string> {
        const token = await generateGhostToken(this.apiKey);

        return `Ghost ${token}`;
    }

    /**
     * Make an authenticated API request to Ghost.
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
                Authorization: token,
                'Content-Type': 'application/json',
                Accept: 'application/json'
            }
        };

        if (body) {
            options.body = JSON.stringify(body);
        }

        return requestUrl(options);
    }

    /**
     * Fetch bookmark metadata for an external URL.
     */
    async getBookmarkData(url: string): Promise<BookmarkResult> {
        try {
            const endpoint =
                `/oembed/?url=${encodeURIComponent(url)}&type=bookmark`;

            const response = await this.request(
                'GET',
                endpoint
            );

            if (response.status >= 200 && response.status < 300) {
                return {
                    success: true,
                    data: response.json as Record<string, unknown>
                };
            }

            const errorData = response.json as GhostErrorResponse;

            return {
                success: false,
                error:
                    errorData.errors?.[0]?.message ||
                    `HTTP ${response.status}`
            };
        } catch (error) {
            return {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : 'Unknown error'
            };
        }
    }

    /**
     * Test the connection to Ghost.
     */
    async testConnection(): Promise<
        | { success: true; siteName: string }
        | { success: false; error: string }
    > {
        try {
            const response = await this.request(
                'GET',
                '/site/'
            );

            if (response.status >= 200 && response.status < 300) {
                const data = response.json as GhostSiteResponse;

                return {
                    success: true,
                    siteName: data.site?.title || 'Unknown Site'
                };
            }

            const errorData = response.json as GhostErrorResponse;

            return {
                success: false,
                error:
                    errorData.errors?.[0]?.message ||
                    `HTTP ${response.status}`
            };
        } catch (error) {
            return {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : 'Unknown error'
            };
        }
    }

    /**
     * Build the query string for a create/update.
     *
     * Normal posts use source=html.
     * Native Lexical posts do not need source=html.
     */
    private buildPostQuery(
        options?: PublishOptions,
        source: 'html' | 'lexical' = 'html'
    ): string {
        const params = new URLSearchParams();

        if (source === 'html') {
            params.set('source', 'html');
        }

        if (options?.newsletterSlug) {
            params.set(
                'newsletter',
                options.newsletterSlug
            );
        }

        const query = params.toString();

        return query ? `?${query}` : '';
    }

    /**
     * Create a new post on Ghost.
     */
    async createPost(
        payload: GhostPostPayload,
        options?: PublishOptions
    ): Promise<PostResult> {
        try {
            const source: 'html' | 'lexical' =
                payload.posts[0]?.lexical
                    ? 'lexical'
                    : 'html';

            const response = await this.request(
                'POST',
                `/posts/${this.buildPostQuery(options, source)}`,
                payload
            );

            return this.parsePostResponse(response);
        } catch (error) {
            return {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : 'Unknown error'
            };
        }
    }

    /**
     * Update an existing post on Ghost.
     *
     * The payload MUST include the current updated_at value
     * so Ghost can detect editing conflicts.
     */
    async updatePost(
        id: string,
        payload: GhostPostPayload,
        options?: PublishOptions
    ): Promise<PostResult> {
        try {
            const source: 'html' | 'lexical' =
                payload.posts[0]?.lexical
                    ? 'lexical'
                    : 'html';

            const response = await this.request(
                'PUT',
                `/posts/${id}/${this.buildPostQuery(options, source)}`,
                payload
            );

            return this.parsePostResponse(response);
        } catch (error) {
            return {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : 'Unknown error'
            };
        }
    }

    /**
     * Fetch a single post by id,
     * including its rendered HTML content.
     */
    async getPost(id: string): Promise<PostResult> {
        try {
            const response = await this.request(
                'GET',
                `/posts/${id}/?formats=html`
            );

            return this.parsePostResponse(response);
        } catch (error) {
            return {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : 'Unknown error'
            };
        }
    }

    /**
     * List the site's active newsletters.
     */
    async getNewsletters(): Promise<GhostNewsletter[]> {
        try {
            const response = await this.request(
                'GET',
                '/newsletters/?filter=status:active&limit=all'
            );

            if (response.status >= 200 && response.status < 300) {
                const data =
                    response.json as GhostNewslettersResponse;

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
    private parsePostResponse(
        response: RequestUrlResponse
    ): PostResult {
        if (response.status >= 200 && response.status < 300) {
            const data = response.json as GhostPostResponse;

            const post = data.posts?.[0];

            if (!post) {
                return {
                    success: false,
                    error: 'Ghost returned no post data'
                };
            }

            return {
                success: true,
                post
            };
        }

        const errorData =
            response.json as GhostErrorResponse;

        return {
            success: false,
            error:
                errorData.errors?.[0]?.message ||
                `HTTP ${response.status}`
        };
    }

    /**
     * Upload an image to Ghost.
     */
    async uploadImage(
        filename: string,
        imageData: ArrayBuffer
    ): Promise<
        | { success: true; url: string }
        | { success: false; error: string }
    > {
        try {
            const token = await this.getAuthHeader();

            const url =
                `${this.ghostUrl}/ghost/api/admin/images/upload/`;

            const ext =
                filename.split('.').pop()?.toLowerCase() || '';

            const mimeTypes: Record<string, string> = {
                jpg: 'image/jpeg',
                jpeg: 'image/jpeg',
                png: 'image/png',
                gif: 'image/gif',
                webp: 'image/webp',
                svg: 'image/svg+xml'
            };

            const contentType =
                mimeTypes[ext] ||
                'application/octet-stream';

            const boundary =
                '----GhostyPostyBoundary' +
                Math.random().toString(36).substring(2);

            const header =
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
                `Content-Type: ${contentType}\r\n\r\n`;

            const footer =
                `\r\n--${boundary}--\r\n`;

            const headerBytes =
                new TextEncoder().encode(header);

            const footerBytes =
                new TextEncoder().encode(footer);

            const imageBytes =
                new Uint8Array(imageData);

            const body = new Uint8Array(
                headerBytes.length +
                imageBytes.length +
                footerBytes.length
            );

            body.set(
                headerBytes,
                0
            );

            body.set(
                imageBytes,
                headerBytes.length
            );

            body.set(
                footerBytes,
                headerBytes.length + imageBytes.length
            );

            const response = await requestUrl({
                url,
                method: 'POST',
                headers: {
                    Authorization: token,
                    'Content-Type':
                        `multipart/form-data; boundary=${boundary}`
                },
                body: body.buffer
            });

            if (response.status >= 200 && response.status < 300) {
                const data =
                    response.json as GhostImageUploadResponse;

                if (data.images && data.images.length > 0) {
                    return {
                        success: true,
                        url: data.images[0].url
                    };
                }

                return {
                    success: false,
                    error: 'No image URL returned from Ghost'
                };
            }

            const errorData =
                response.json as GhostErrorResponse;

            return {
                success: false,
                error:
                    errorData.errors?.[0]?.message ||
                    `HTTP ${response.status}`
            };
        } catch (error) {
            return {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : 'Unknown error'
            };
        }
    }
}