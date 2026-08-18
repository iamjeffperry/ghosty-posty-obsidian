/**
 * Utilities for creating Ghost Embed cards from Ghost's oEmbed response.
 *
 * The plugin asks Ghost for provider-specific embed HTML, then wraps that
 * HTML in the same figure structure Ghost recognizes when importing HTML.
 */

interface GhostEmbedResponse {
    type?: unknown;
    html?: unknown;
    url?: unknown;
}

function getString(value: unknown): string {
    return typeof value === 'string'
        ? value
        : '';
}

/**
 * Build the HTML structure Ghost recognizes as an Embed card.
 * Returns null when Ghost did not return usable embed HTML.
 */
export function buildGhostEmbedHtml(
    _originalUrl: string,
    data: Record<string, unknown>
): string | null {
    const response =
        data as GhostEmbedResponse;

    const type =
        getString(response.type);

    const html =
        getString(response.html).trim();

    /*
     * A #media post should only become an Embed card.
     * Never silently turn it into a Bookmark card.
     */
    if (
        type === 'bookmark' ||
        !html
    ) {
        return null;
    }

    return `
<figure class="kg-card kg-embed-card">
    ${html}
</figure>
`.trim();
}

/**
 * Replace the paragraph containing the standalone media URL
 * with the generated Ghost Embed card.
 */
export function replaceStandaloneUrlWithEmbed(
    html: string,
    url: string,
    embedHtml: string
): string {
    const parser = new DOMParser();

    const document = parser.parseFromString(
        html,
        'text/html'
    );

    const paragraphs =
        Array.from(
            document.body.querySelectorAll('p')
        );

    for (const paragraph of paragraphs) {
        const text =
            paragraph.textContent?.trim() || '';

        if (text !== url) {
            continue;
        }

        const template =
            document.createElement('template');

        template.innerHTML =
            embedHtml.trim();

        const embed =
            template.content.firstElementChild;

        if (embed) {
            paragraph.replaceWith(embed);

            return document.body.innerHTML;
        }
    }

    /*
     * If we couldn't identify the URL paragraph,
     * leave the original HTML untouched.
     */
    return html;
}
