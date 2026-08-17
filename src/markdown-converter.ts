import { Marked } from 'marked';
import { markedEmoji } from 'marked-emoji';
import { gemoji } from 'gemoji';
import { ImageReference } from './types';

/**
 * Escape a string for safe use inside a double-quoted HTML attribute
 */
function escapeHtmlAttribute(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Build the Markdown-to-HTML converter, configured to match Ghost's needs:
 * GFM, emoji shortcodes, and links that open in a new window.
 */
function createConverter(): Marked {
    const emojis: Record<string, string> = {};

    for (const entry of gemoji) {
        for (const name of entry.names) {
            emojis[name] = entry.emoji;
        }
    }

    const converter = new Marked();

    converter.use(
        markedEmoji({
            emojis,
            renderer: (token) => token.emoji
        })
    );

    converter.use({
        gfm: true,
        breaks: false,
        renderer: {
            link({ href, title, tokens }): string {
                const text = this.parser.parseInline(tokens);

                const titleAttr = title
                    ? ` title="${escapeHtmlAttribute(title)}"`
                    : '';

                return `<a href="${escapeHtmlAttribute(href)}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
            }
        }
    });

    return converter;
}

const markdownConverter = createConverter();

/**
 * Remove YAML frontmatter from markdown content.
 */
function stripFrontmatter(
    markdown: string
): {
    content: string;
    frontmatterEndIndex: number;
} {
    const frontmatterRegex =
        /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

    const match = markdown.match(frontmatterRegex);

    if (match) {
        return {
            content: markdown.slice(match[0].length),
            frontmatterEndIndex: match[0].length
        };
    }

    return {
        content: markdown,
        frontmatterEndIndex: 0
    };
}

/**
 * Find the first standalone external URL in the Markdown body.
 *
 * A standalone URL means the entire non-empty line is just:
 *
 * https://example.com/article
 *
 * This lets us distinguish a link-post destination from links that may
 * appear naturally inside paragraphs.
 */
function findFirstStandaloneUrl(
    markdown: string
): string | null {
    const lines = markdown.split(/\r?\n/);

    for (const line of lines) {
        const trimmed = line.trim();

        if (/^https?:\/\/\S+$/.test(trimmed)) {
            return trimmed;
        }
    }

    return null;
}

/**
 * Check if a path is a local file rather than an external URL.
 */
function isLocalPath(path: string): boolean {
    return (
        !path.startsWith('http://') &&
        !path.startsWith('https://') &&
        !path.startsWith('data:')
    );
}

/**
 * Extract all images from markdown content.
 * Handles both ![alt](path) and ![[path]] syntax.
 */
function extractAllImages(
    markdown: string
): ImageReference[] {
    const images: ImageReference[] = [];

    const { content } = stripFrontmatter(markdown);

    const lines = content.split(/\r?\n/);

    let firstContentLineIndex = -1;

    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() !== '') {
            firstContentLineIndex = i;
            break;
        }
    }

    // Standard Markdown images: ![alt](path)
    const markdownImageRegex =
        /!\[([^\]]*)\]\(([^)]+)\)/g;

    let match;

    while (
        (match = markdownImageRegex.exec(content)) !== null
    ) {
        const path = match[2];

        if (isLocalPath(path)) {
            const beforeMatch =
                content.substring(0, match.index);

            const lineNumber =
                beforeMatch.split(/\r?\n/).length - 1;

            const isFirstLine =
                lineNumber === firstContentLineIndex;

            images.push({
                originalSyntax: match[0],
                path,
                alt: match[1],
                isEmbed: false,
                isFirstLine
            });
        }
    }

    // Obsidian embeds: ![[image.png]]
    const embedImageRegex =
        /!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

    while (
        (match = embedImageRegex.exec(content)) !== null
    ) {
        const path = match[1];

        const ext =
            path.split('.').pop()?.toLowerCase() || '';

        const imageExtensions = [
            'png',
            'jpg',
            'jpeg',
            'gif',
            'webp',
            'svg',
            'bmp'
        ];

        if (imageExtensions.includes(ext)) {
            const beforeMatch =
                content.substring(0, match.index);

            const lineNumber =
                beforeMatch.split(/\r?\n/).length - 1;

            const isFirstLine =
                lineNumber === firstContentLineIndex;

            images.push({
                originalSyntax: match[0],
                path,
                alt: match[2] || '',
                isEmbed: true,
                isFirstLine
            });
        }
    }

    return images;
}

/**
 * Convert Obsidian wiki links to plain text.
 *
 * [[Page Name]] -> Page Name
 * [[Page Name|Display Text]] -> Display Text
 */
function convertWikiLinks(
    markdown: string
): string {
    return markdown.replace(
        /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
        (
            _match: string,
            link: string,
            display: string | undefined
        ) => {
            return display || link;
        }
    );
}

/**
 * Convert Obsidian image embeds to standard Markdown.
 *
 * ![[image.png]] -> ![](image.png)
 */
function convertImageEmbeds(
    markdown: string
): string {
    return markdown.replace(
        /!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
        (
            _match: string,
            path: string,
            alt: string | undefined
        ) => {
            const encodedPath = encodeURI(path);

            return `![${alt || ''}](${encodedPath})`;
        }
    );
}

export interface ConversionResult {
    html: string;
    warnings: string[];
    images: ImageReference[];
    featuredImage: ImageReference | null;

    /**
     * First external URL found alone on a line in the post body.
     *
     * Later, #link posts will use this to generate a Ghost Bookmark card.
     */
    bookmarkUrl: string | null;
}

/**
 * Convert Obsidian Markdown to HTML for Ghost.
 */
export function convertMarkdownToHtml(
    markdown: string
): ConversionResult {
    const warnings: string[] = [];

    // Extract images first.
    const allImages =
        extractAllImages(markdown);

    const featuredImage =
        allImages.find(
            (img) => img.isFirstLine
        ) || null;

    const contentImages = featuredImage
        ? allImages.filter(
              (img) => !img.isFirstLine
          )
        : allImages;

    // Remove frontmatter.
    let { content: processed } =
        stripFrontmatter(markdown);

    /*
     * Capture a standalone URL BEFORE converting Markdown to HTML.
     *
     * Example:
     *
     * https://example.com/article
     *
     * Some commentary here.
     */
    const bookmarkUrl =
        findFirstStandaloneUrl(processed);

    // Remove featured image from body.
    if (featuredImage) {
        const lines =
            processed.split(/\r?\n/);

        const filteredLines = lines.filter(
            (line, index) => {
                let firstNonEmptyIndex = -1;

                for (
                    let i = 0;
                    i < lines.length;
                    i++
                ) {
                    if (
                        lines[i].trim() !== ''
                    ) {
                        firstNonEmptyIndex = i;
                        break;
                    }
                }

                return !(
                    index ===
                        firstNonEmptyIndex &&
                    line.includes(
                        featuredImage.originalSyntax
                    )
                );
            }
        );

        processed =
            filteredLines.join('\n');
    }

    // Convert Obsidian image embeds.
    processed =
        convertImageEmbeds(processed);

    // Convert wiki links.
    processed =
        convertWikiLinks(processed);

    // Convert Markdown to HTML.
    const html =
        markdownConverter.parse(
            processed,
            {
                async: false
            }
        );

    return {
        html,
        warnings,
        images: contentImages,
        featuredImage,
        bookmarkUrl
    };
}

/**
 * Replace local image paths in HTML with uploaded Ghost URLs.
 */
export function replaceImageUrls(
    html: string,
    urlMap: Map<string, string>
): string {
    let result = html;

    for (
        const [localPath, ghostUrl]
        of urlMap
    ) {
        const pathVariants = [
            localPath,
            encodeURI(localPath)
        ];

        for (
            const pathVariant
            of pathVariants
        ) {
            const escapedPath =
                pathVariant.replace(
                    /[.*+?^${}()|[\]\\]/g,
                    '\\$&'
                );

            const regex =
                new RegExp(
                    `src=["']${escapedPath}["']`,
                    'g'
                );

            result =
                result.replace(
                    regex,
                    `src="${ghostUrl}"`
                );
        }
    }

    return result;
}