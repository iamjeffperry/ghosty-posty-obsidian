/**
 * Utilities for creating Ghost Bookmark cards.
 */

interface BookmarkMetadata {
    title?: string;
    description?: string;
    author?: string;
    publisher?: string;
    icon?: string;
    thumbnail?: string;
}

interface GhostBookmarkResponse {
    url?: string;
    metadata?: BookmarkMetadata;
}

/**
 * Escape text for safe use inside HTML.
 */
function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Safely convert an unknown value to a string.
 */
function getString(value: unknown): string {
    return typeof value === 'string'
        ? value
        : '';
}

/**
 * Build the HTML structure Ghost recognizes as a Bookmark card.
 */
export function buildGhostBookmarkHtml(
    originalUrl: string,
    data: Record<string, unknown>
): string {
    const response =
        data as GhostBookmarkResponse;

    const url =
        getString(response.url) ||
        originalUrl;

    const metadata =
        response.metadata &&
        typeof response.metadata === 'object'
            ? response.metadata
            : {};

    const title =
        getString(metadata.title) ||
        url;

    const description =
        getString(metadata.description);

    const author =
        getString(metadata.author);

    const publisher =
        getString(metadata.publisher);

    const icon =
        getString(metadata.icon);

    const thumbnail =
        getString(metadata.thumbnail);

    const escapedUrl =
        escapeHtml(url);

    const escapedTitle =
        escapeHtml(title);

    const escapedDescription =
        escapeHtml(description);

    const escapedAuthor =
        escapeHtml(author);

    const escapedPublisher =
        escapeHtml(publisher);

    const escapedIcon =
        escapeHtml(icon);

    const escapedThumbnail =
        escapeHtml(thumbnail);

    const iconHtml = icon
        ? `<img class="kg-bookmark-icon" src="${escapedIcon}" alt="">`
        : '';

    /*
     * Ghost intentionally uses these class names this way
     * for backwards compatibility.
     */
    const publisherHtml = publisher
        ? `<span class="kg-bookmark-author">${escapedPublisher}</span>`
        : '';

    const authorHtml = author
        ? `<span class="kg-bookmark-publisher">${escapedAuthor}</span>`
        : '';

    const thumbnailHtml = thumbnail
        ? `
            <div class="kg-bookmark-thumbnail">
                <img src="${escapedThumbnail}" alt="">
            </div>
        `
        : '';

    return `
<figure class="kg-card kg-bookmark-card">
    <a class="kg-bookmark-container" href="${escapedUrl}">
        <div class="kg-bookmark-content">
            <div class="kg-bookmark-title">${escapedTitle}</div>
            <div class="kg-bookmark-description">${escapedDescription}</div>
            <div class="kg-bookmark-metadata">
                ${iconHtml}
                ${publisherHtml}
                ${authorHtml}
            </div>
        </div>
        ${thumbnailHtml}
    </a>
</figure>
`.trim();
}

/**
 * Replace the paragraph containing the standalone URL
 * with the generated Ghost Bookmark card.
 */
export function replaceStandaloneUrlWithBookmark(
    html: string,
    url: string,
    bookmarkHtml: string
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
            bookmarkHtml.trim();

        const bookmark =
            template.content.firstElementChild;

        if (bookmark) {
            paragraph.replaceWith(bookmark);

            return document.body.innerHTML;
        }
    }

    /*
     * If we couldn't identify the URL paragraph,
     * leave the original HTML untouched.
     */
    return html;
}