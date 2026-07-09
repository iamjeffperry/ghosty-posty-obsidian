import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertMarkdownToHtml, replaceImageUrls } from './markdown-converter';

test('converts basic markdown to HTML', () => {
    const { html } = convertMarkdownToHtml('# Hello\n\nSome **bold** text.');
    assert.match(html, /<h1[^>]*>Hello<\/h1>/);
    assert.match(html, /<strong>bold<\/strong>/);
});

test('strips YAML frontmatter from the rendered body', () => {
    const md = '---\ntitle: My Post\ntags: [a, b]\n---\n\nActual content.';
    const { html } = convertMarkdownToHtml(md);
    assert.ok(!html.includes('title:'), 'frontmatter keys should not appear in output');
    assert.ok(!html.includes('My Post'), 'frontmatter values should not appear in output');
    assert.match(html, /Actual content\./);
});

test('always returns a warnings array', () => {
    const { warnings } = convertMarkdownToHtml('plain text');
    assert.ok(Array.isArray(warnings));
});

test('collects local standard-markdown images', () => {
    const md = 'Intro paragraph.\n\n![a cat](images/cat.png)';
    const { images } = convertMarkdownToHtml(md);
    assert.equal(images.length, 1);
    assert.equal(images[0].path, 'images/cat.png');
    assert.equal(images[0].alt, 'a cat');
    assert.equal(images[0].isEmbed, false);
});

test('ignores external (http/https) images', () => {
    const md = 'Intro.\n\n![remote](https://example.com/pic.png)';
    const { images, featuredImage } = convertMarkdownToHtml(md);
    assert.equal(images.length, 0);
    assert.equal(featuredImage, null);
});

test('collects Obsidian embed images and renders them as <img>', () => {
    const md = 'Intro.\n\n![[diagram.png]]';
    const { images, html } = convertMarkdownToHtml(md);
    assert.equal(images.length, 1);
    assert.equal(images[0].path, 'diagram.png');
    assert.equal(images[0].isEmbed, true);
    assert.match(html, /<img[^>]+src="diagram\.png"/);
});

test('honours alt text in Obsidian embeds', () => {
    const md = 'Intro.\n\n![[diagram.png|architecture]]';
    const { images } = convertMarkdownToHtml(md);
    assert.equal(images[0].alt, 'architecture');
});

test('does not treat non-image embeds as images', () => {
    const md = 'Intro.\n\n![[Some Note.md]]\n\n![[data.csv]]';
    const { images } = convertMarkdownToHtml(md);
    assert.equal(images.length, 0);
});

test('promotes a first-line image to the featured image and removes it from the body', () => {
    const md = '![[hero.png]]\n\n# Title\n\nBody text with ![[inline.png]].';
    const { featuredImage, images, html } = convertMarkdownToHtml(md);
    assert.ok(featuredImage, 'expected a featured image');
    assert.equal(featuredImage?.path, 'hero.png');
    // Featured image is excluded from the content image list...
    assert.equal(images.length, 1);
    assert.equal(images[0].path, 'inline.png');
    // ...and removed from the rendered HTML body.
    assert.ok(!html.includes('hero.png'), 'featured image should not appear in the body');
    assert.match(html, /<img[^>]+src="inline\.png"/);
});

test('detects a first-line featured image even after frontmatter', () => {
    const md = '---\ntitle: Post\n---\n\n![[hero.png]]\n\nBody.';
    const { featuredImage } = convertMarkdownToHtml(md);
    assert.equal(featuredImage?.path, 'hero.png');
});

test('URL-encodes embed paths that contain spaces', () => {
    const md = 'Intro.\n\n![[my photo.png]]';
    const { html } = convertMarkdownToHtml(md);
    assert.match(html, /src="my%20photo\.png"/);
});

test('flattens wiki links to plain text', () => {
    const { html } = convertMarkdownToHtml('See [[Some Page]] for details.');
    assert.match(html, /See Some Page for details\./);
    assert.ok(!html.includes('[['), 'wiki bracket syntax should be gone');
});

test('uses the display text of aliased wiki links', () => {
    const { html } = convertMarkdownToHtml('Read [[Target Note|the guide]].');
    assert.match(html, /Read the guide\./);
    assert.ok(!html.includes('Target Note'));
});

test('opens real markdown links in a new tab', () => {
    const { html } = convertMarkdownToHtml('[click](https://example.com)');
    assert.match(html, /href="https:\/\/example\.com"/);
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noopener noreferrer"/);
});

test('converts emoji shortcodes to emoji', () => {
    const { html } = convertMarkdownToHtml('Nice work :tada:');
    assert.ok(!html.includes(':tada:'), 'shortcode should be replaced');
});

test('renders GFM tables', () => {
    const md = '| A | B |\n| - | - |\n| 1 | 2 |';
    const { html } = convertMarkdownToHtml(md);
    assert.match(html, /<table>/);
    assert.match(html, /<td>1<\/td>/);
});

// --- replaceImageUrls ---------------------------------------------------

test('replaceImageUrls swaps local src paths for Ghost URLs', () => {
    const html = '<img src="images/cat.png" alt="">';
    const map = new Map([['images/cat.png', 'https://cdn.ghost.io/cat.png']]);
    const result = replaceImageUrls(html, map);
    assert.match(result, /src="https:\/\/cdn\.ghost\.io\/cat\.png"/);
    assert.ok(!result.includes('images/cat.png'));
});

test('replaceImageUrls matches URL-encoded path variants', () => {
    const html = '<img src="my%20photo.png" alt="">';
    const map = new Map([['my photo.png', 'https://cdn.ghost.io/p.png']]);
    const result = replaceImageUrls(html, map);
    assert.match(result, /src="https:\/\/cdn\.ghost\.io\/p\.png"/);
});

test('replaceImageUrls leaves unrelated URLs untouched', () => {
    const html = '<img src="https://other.com/x.png" alt="">';
    const map = new Map([['images/cat.png', 'https://cdn.ghost.io/cat.png']]);
    const result = replaceImageUrls(html, map);
    assert.equal(result, html);
});
