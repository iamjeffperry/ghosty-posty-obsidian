import {
    App,
    Modal,
    Setting,
    Notice,
    Vault,
    TFile,
    MetadataCache
} from 'obsidian';

import {
    PostMetadata,
    GhostPostPayload,
    GhostPostResult,
    PostStatus,
    PostVisibility,
    DeliveryMode,
    ImageReference,
    GhostNewsletter
} from './types';

import {
    GhostAPI,
    PublishOptions
} from './ghost-api';

import {
    ConversionResult,
    replaceImageUrls
} from './markdown-converter';

import {
    buildGhostBookmarkHtml,
    replaceStandaloneUrlWithBookmark
} from './bookmark-card';

export class PublishModal extends Modal {
    private metadata: PostMetadata;
    private conversionResult: ConversionResult;
    private ghostUrl: string;
    private apiKey: string;
    private vault: Vault;
    private metadataCache: MetadataCache;
    private sourceFile: TFile;
    private onSuccess: (
        post: GhostPostResult,
        wasCreate: boolean
    ) => void;

    /** True when this note already exists on Ghost (update mode). */
    private readonly isUpdate: boolean;

    // Editable form values
    private editableTitle: string;
    private editableStatus: PostStatus;
    private editableTags: string;
    private editableVisibility: PostVisibility;
    private editableFeatured: boolean = false;
    private editableScheduledDate: string = '';

    // Delivery / newsletter
    private newsletters: GhostNewsletter[] = [];
    private deliveryMode: DeliveryMode = 'post';
    private selectedNewsletterSlug: string = '';

    // If a server-side change is detected,
    // require a second confirming click.
    private overwriteConfirmed: boolean = false;

    // UI elements
    private publishButton: HTMLButtonElement | null = null;
    private statusEl: HTMLElement | null = null;
    private scheduleDateContainer: HTMLElement | null = null;
    private deliveryContainer: HTMLElement | null = null;
    private newsletterPickerContainer: HTMLElement | null = null;

    constructor(
        app: App,
        vault: Vault,
        metadataCache: MetadataCache,
        sourceFile: TFile,
        metadata: PostMetadata,
        conversionResult: ConversionResult,
        ghostUrl: string,
        apiKey: string,
        onSuccess: (
            post: GhostPostResult,
            wasCreate: boolean
        ) => void
    ) {
        super(app);

        this.vault = vault;
        this.metadataCache = metadataCache;
        this.sourceFile = sourceFile;
        this.metadata = metadata;
        this.conversionResult = conversionResult;
        this.ghostUrl = ghostUrl;
        this.apiKey = apiKey;
        this.onSuccess = onSuccess;
        this.isUpdate = metadata.existing !== undefined;

        // Initialize editable values
        this.editableTitle = metadata.title;
        this.editableStatus = metadata.status;
        this.editableTags = metadata.tags.join(', ');
        this.editableVisibility = metadata.visibility;
    }

    onOpen() {
        const { contentEl } = this;

        contentEl.empty();
        contentEl.addClass('ghosty-posty-modal');

        contentEl.createEl('h2', {
            text: this.isUpdate
                ? 'Update on Ghost'
                : 'Publish to Ghost'
        });

        if (this.isUpdate) {
            const note = contentEl.createDiv({
                cls: 'ghosty-posty-field'
            });

            note.createEl('span', {
                text:
                    'This note is already on Ghost — publishing updates the existing post.'
            });
        }

        // Editable fields section
        const formSection = contentEl.createDiv({
            cls: 'ghosty-posty-form'
        });

        // Title input
        new Setting(formSection)
            .setName('Title')
            .addText(text =>
                text
                    .setValue(this.editableTitle)
                    .onChange(value => {
                        this.editableTitle = value;
                    })
            );

        // Status dropdown
        new Setting(formSection)
            .setName('Status')
            .addDropdown(dropdown =>
                dropdown
                    .addOption('draft', 'Draft')
                    .addOption('published', 'Published')
                    .addOption('scheduled', 'Scheduled')
                    .setValue(this.editableStatus)
                    .onChange(value => {
                        this.editableStatus =
                            value as PostStatus;

                        this.toggleScheduleDateVisibility();
                        this.toggleDeliveryVisibility();
                    })
            );

        // Schedule date picker
        this.scheduleDateContainer =
            formSection.createDiv({
                cls: 'ghosty-posty-schedule-picker'
            });

        new Setting(this.scheduleDateContainer)
            .setName('Schedule for')
            .setDesc(
                'Date and time to publish (your local timezone)'
            )
            .addText(text => {
                text.inputEl.type = 'datetime-local';

                // Default to the next hour
                const nextHour = new Date();

                nextHour.setHours(
                    nextHour.getHours() + 1,
                    0,
                    0,
                    0
                );

                const defaultDate =
                    this.toLocalDatetimeString(
                        nextHour
                    );

                text.setValue(defaultDate);

                this.editableScheduledDate =
                    defaultDate;

                text.onChange(value => {
                    this.editableScheduledDate =
                        value;
                });
            });

        this.toggleScheduleDateVisibility();

        // Featured toggle
        new Setting(formSection)
            .setName('Featured')
            .setDesc(
                'Mark this post as featured'
            )
            .addToggle(toggle =>
                toggle
                    .setValue(
                        this.editableFeatured
                    )
                    .onChange(value => {
                        this.editableFeatured =
                            value;
                    })
            );

        // Tags input
        new Setting(formSection)
            .setName('Tags')
            .setDesc(
                'Comma-separated list of tags'
            )
            .addText(text =>
                text
                    .setValue(
                        this.editableTags
                    )
                    .onChange(value => {
                        this.editableTags =
                            value;
                    })
            );

        // Visibility dropdown
        new Setting(formSection)
            .setName('Visibility')
            .setDesc(
                'Who can read this post'
            )
            .addDropdown(dropdown =>
                dropdown
                    .addOption(
                        'public',
                        'Public'
                    )
                    .addOption(
                        'members',
                        'Members (all signed-in members)'
                    )
                    .addOption(
                        'paid',
                        'Paid members only'
                    )
                    .setValue(
                        this.editableVisibility
                    )
                    .onChange(value => {
                        this.editableVisibility =
                            value as PostVisibility;
                    })
            );

        // Delivery / newsletter section
        this.deliveryContainer =
            formSection.createDiv({
                cls: 'ghosty-posty-delivery'
            });

        void this.buildDeliverySection();

        // Image info section
        const totalImages =
            this.conversionResult.images.length +
            (
                this.conversionResult.featuredImage
                    ? 1
                    : 0
            );

        if (
            totalImages > 0 ||
            this.conversionResult.featuredImage
        ) {
            const imageSection =
                contentEl.createDiv({
                    cls: 'ghosty-posty-images'
                });

            imageSection.createEl('h3', {
                text: 'Images'
            });

            if (
                this.conversionResult.featuredImage
            ) {
                const featuredDiv =
                    imageSection.createDiv({
                        cls: 'ghosty-posty-field'
                    });

                featuredDiv.createEl(
                    'strong',
                    {
                        text: 'Featured image: '
                    }
                );

                featuredDiv.createEl(
                    'span',
                    {
                        text: this.getFilename(
                            this
                                .conversionResult
                                .featuredImage
                                .path
                        )
                    }
                );
            }

            if (
                this.conversionResult.images
                    .length > 0
            ) {
                const countDiv =
                    imageSection.createDiv({
                        cls: 'ghosty-posty-field'
                    });

                countDiv.createEl(
                    'strong',
                    {
                        text: 'Content images: '
                    }
                );

                countDiv.createEl(
                    'span',
                    {
                        text:
                            `${this.conversionResult.images.length}`
                    }
                );
            }
        }

        // Scheduled date from metadata
        if (
            this.metadata.status ===
                'scheduled' &&
            this.metadata.publishedAt
        ) {
            const scheduleSection =
                contentEl.createDiv({
                    cls: 'ghosty-posty-schedule'
                });

            const dateDiv =
                scheduleSection.createDiv({
                    cls: 'ghosty-posty-field'
                });

            dateDiv.createEl(
                'strong',
                {
                    text: 'Scheduled for: '
                }
            );

            dateDiv.createEl(
                'span',
                {
                    text: this.formatDate(
                        this.metadata
                            .publishedAt
                    )
                }
            );
        }

        // Status/progress area
        this.statusEl =
            contentEl.createDiv({
                cls: 'ghosty-posty-status'
            });

        // Buttons
        const buttonContainer =
            contentEl.createDiv({
                cls: 'ghosty-posty-buttons'
            });

        const cancelButton =
            buttonContainer.createEl(
                'button',
                {
                    text: 'Cancel'
                }
            );

        cancelButton.addEventListener(
            'click',
            () => this.close()
        );

        this.publishButton =
            buttonContainer.createEl(
                'button',
                {
                    text: this.isUpdate
                        ? 'Update'
                        : 'Publish',
                    cls: 'mod-cta'
                }
            );

        this.publishButton.addEventListener(
            'click',
            () => {
                void this.publish();
            }
        );
    }

    /**
     * Fetch the site's active newsletters
     * and build the delivery selector.
     */
    private async buildDeliverySection(): Promise<void> {
        if (!this.deliveryContainer) {
            return;
        }

        const api = new GhostAPI(
            this.ghostUrl,
            this.apiKey
        );

        this.newsletters =
            await api.getNewsletters();

        this.deliveryContainer.empty();

        if (
            this.newsletters.length === 0
        ) {
            this.toggleDeliveryVisibility();

            return;
        }

        this.selectedNewsletterSlug =
            this.newsletters[0].slug;

        new Setting(
            this.deliveryContainer
        )
            .setName('Publish as')
            .setDesc(
                'Post, email, or both'
            )
            .addDropdown(dropdown =>
                dropdown
                    .addOption(
                        'post',
                        'Post only'
                    )
                    .addOption(
                        'newsletter_only',
                        'Email only'
                    )
                    .addOption(
                        'post_and_newsletter',
                        'Post and email'
                    )
                    .setValue(
                        this.deliveryMode
                    )
                    .onChange(value => {
                        this.deliveryMode =
                            value as DeliveryMode;

                        this
                            .toggleNewsletterPickerVisibility();
                    })
            );

        // Newsletter picker
        this.newsletterPickerContainer =
            this.deliveryContainer.createDiv({
                cls:
                    'ghosty-posty-newsletter-picker'
            });

        if (
            this.newsletters.length > 1
        ) {
            new Setting(
                this
                    .newsletterPickerContainer
            )
                .setName('Newsletter')
                .addDropdown(dropdown => {
                    for (
                        const nl
                        of this.newsletters
                    ) {
                        dropdown.addOption(
                            nl.slug,
                            nl.name
                        );
                    }

                    dropdown.setValue(
                        this
                            .selectedNewsletterSlug
                    );

                    dropdown.onChange(
                        value => {
                            this
                                .selectedNewsletterSlug =
                                value;
                        }
                    );
                });
        }

        this.toggleDeliveryVisibility();
        this.toggleNewsletterPickerVisibility();
    }

    private getFilename(
        path: string
    ): string {
        return (
            path.split('/').pop() ||
            path
        );
    }

    private formatDate(
        isoDate: string
    ): string {
        try {
            const date =
                new Date(isoDate);

            return date.toLocaleString();
        } catch {
            return isoDate;
        }
    }

    /**
     * Convert a Date to the format
     * required by datetime-local.
     */
    private toLocalDatetimeString(
        date: Date
    ): string {
        const year =
            date.getFullYear();

        const month =
            String(
                date.getMonth() + 1
            ).padStart(
                2,
                '0'
            );

        const day =
            String(
                date.getDate()
            ).padStart(
                2,
                '0'
            );

        const hours =
            String(
                date.getHours()
            ).padStart(
                2,
                '0'
            );

        const minutes =
            String(
                date.getMinutes()
            ).padStart(
                2,
                '0'
            );

        return (
            `${year}-${month}-${day}` +
            `T${hours}:${minutes}`
        );
    }

    /**
     * Show/hide the schedule picker.
     */
    private toggleScheduleDateVisibility() {
        if (
            this.scheduleDateContainer
        ) {
            this.scheduleDateContainer
                .toggleClass(
                    'is-hidden',
                    this.editableStatus !==
                        'scheduled'
                );
        }
    }

    /**
     * Newsletter delivery is only
     * available for published or
     * scheduled posts.
     */
    private toggleDeliveryVisibility() {
        if (
            !this.deliveryContainer
        ) {
            return;
        }

        const canSend =
            this.newsletters.length > 0 &&
            (
                this.editableStatus ===
                    'published' ||
                this.editableStatus ===
                    'scheduled'
            );

        this.deliveryContainer.toggleClass(
            'is-hidden',
            !canSend
        );

        if (!canSend) {
            this.deliveryMode =
                'post';
        }
    }

    private toggleNewsletterPickerVisibility() {
        if (
            this
                .newsletterPickerContainer
        ) {
            const needsPicker =
                this.newsletters.length > 1 &&
                this.deliveryMode !==
                    'post';

            this
                .newsletterPickerContainer
                .toggleClass(
                    'is-hidden',
                    !needsPicker
                );
        }
    }

    private setStatus(
        message: string
    ) {
        if (this.statusEl) {
            this.statusEl.textContent =
                message;
        }
    }

    private setButtonsEnabled(
        enabled: boolean
    ) {
        const buttons =
            this.contentEl
                .querySelectorAll(
                    'button'
                );

        buttons.forEach(btn => {
            if (enabled) {
                btn.removeAttribute(
                    'disabled'
                );
            } else {
                btn.setAttribute(
                    'disabled',
                    'true'
                );
            }
        });
    }

    /**
     * Resolve an image path to
     * an Obsidian TFile.
     */
    private resolveImagePath(
        imagePath: string
    ): TFile | null {
        // Try direct path first
        const directFile =
            this.vault
                .getAbstractFileByPath(
                    imagePath
                );

        if (
            directFile instanceof TFile
        ) {
            return directFile;
        }

        // Try metadata cache
        const resolved =
            this.metadataCache
                .getFirstLinkpathDest(
                    imagePath,
                    this.sourceFile.path
                );

        if (
            resolved instanceof TFile
        ) {
            return resolved;
        }

        // Try relative to source file
        const sourceFolder =
            this.sourceFile.parent
                ?.path || '';

        const relativePath =
            sourceFolder
                ? `${sourceFolder}/${imagePath}`
                : imagePath;

        const relativeFile =
            this.vault
                .getAbstractFileByPath(
                    relativePath
                );

        if (
            relativeFile instanceof TFile
        ) {
            return relativeFile;
        }

        return null;
    }

    /**
     * Upload all images and return
     * a local-path -> Ghost-URL map.
     */
    private async uploadImages(
        api: GhostAPI,
        images: ImageReference[]
    ): Promise<
        | {
            success: true;
            urlMap: Map<
                string,
                string
            >;
        }
        | {
            success: false;
            error: string;
        }
    > {
        const urlMap =
            new Map<
                string,
                string
            >();

        for (
            let i = 0;
            i < images.length;
            i++
        ) {
            const image =
                images[i];

            const filename =
                this.getFilename(
                    image.path
                );

            this.setStatus(
                `Uploading image ${i + 1}/${images.length}: ${filename}...`
            );

            const imageFile =
                this.resolveImagePath(
                    image.path
                );

            if (!imageFile) {
                return {
                    success: false,
                    error:
                        `Image not found: ${image.path}`
                };
            }

            let imageData:
                ArrayBuffer;

            try {
                imageData =
                    await this.vault
                        .readBinary(
                            imageFile
                        );
            } catch {
                return {
                    success: false,
                    error:
                        `Failed to read image: ${image.path}`
                };
            }

            const result =
                await api.uploadImage(
                    filename,
                    imageData
                );

            if (!result.success) {
                return {
                    success: false,
                    error:
                        `Failed to upload ${filename}: ${result.error}`
                };
            }

            urlMap.set(
                image.path,
                result.url
            );
        }

        return {
            success: true,
            urlMap
        };
    }

    private resetButton() {
        this.setButtonsEnabled(true);

        if (
            this.publishButton
        ) {
            this.publishButton
                .textContent =
                this.isUpdate
                    ? 'Update'
                    : 'Publish';
        }
    }

    /**
     * Publish or update the post.
     */
    private async publish() {
        this.setButtonsEnabled(false);

        if (
            this.publishButton
        ) {
            this.publishButton
                .textContent =
                this.isUpdate
                    ? 'Updating...'
                    : 'Publishing...';
        }

        try {
            const api =
                new GhostAPI(
                    this.ghostUrl,
                    this.apiKey
                );

            /*
             * For updates, fetch the current
             * post so Ghost can detect
             * editing conflicts.
             */
            let currentUpdatedAt:
                string | undefined;

            if (
                this.isUpdate &&
                this.metadata.existing
            ) {
                this.setStatus(
                    'Checking Ghost for changes...'
                );

                const fetched =
                    await api.getPost(
                        this.metadata
                            .existing.id
                    );

                if (!fetched.success) {
                    new Notice(
                        `Error: ${fetched.error}`
                    );

                    this.setStatus(
                        `Error: ${fetched.error}`
                    );

                    this.resetButton();

                    return;
                }

                currentUpdatedAt =
                    fetched.post
                        .updated_at;

                const lastSeen =
                    this.metadata
                        .existing
                        .updatedAt;

                if (
                    lastSeen &&
                    lastSeen !==
                        currentUpdatedAt &&
                    !this
                        .overwriteConfirmed
                ) {
                    this.overwriteConfirmed =
                        true;

                    this.setStatus(
                        '⚠ This post was edited on Ghost since you last synced. Updating will overwrite those changes. Click Update again to overwrite, or Cancel and sync first.'
                    );

                    this.setButtonsEnabled(
                        true
                    );

                    if (
                        this.publishButton
                    ) {
                        this.publishButton
                            .textContent =
                            'Overwrite & update';
                    }

                    return;
                }
            }

            /*
             * Parse tags now because we need
             * them both for bookmark handling
             * and the final Ghost payload.
             */
            const tags =
                this.editableTags
                    .split(',')
                    .map(
                        tag =>
                            tag.trim()
                    )
                    .filter(
                        tag =>
                            tag.length >
                            0
                    );

            /*
             * Collect all images to upload.
             */
            const allImages:
                ImageReference[] = [
                    ...(
                        this
                            .conversionResult
                            .featuredImage
                            ? [
                                this
                                    .conversionResult
                                    .featuredImage
                            ]
                            : []
                    ),
                    ...this
                        .conversionResult
                        .images
                ];

            let html =
                this
                    .conversionResult
                    .html;

            let featureImageUrl:
                string | undefined;

            /*
             * Upload images if necessary.
             */
            if (
                allImages.length > 0
            ) {
                const uploadResult =
                    await this
                        .uploadImages(
                            api,
                            allImages
                        );

                if (
                    !uploadResult.success
                ) {
                    new Notice(
                        `Error: ${uploadResult.error}`
                    );

                    this.setStatus(
                        `Error: ${uploadResult.error}`
                    );

                    this.resetButton();

                    return;
                }

                if (
                    this
                        .conversionResult
                        .featuredImage
                ) {
                    featureImageUrl =
                        uploadResult
                            .urlMap
                            .get(
                                this
                                    .conversionResult
                                    .featuredImage
                                    .path
                            );
                }

                html =
                    replaceImageUrls(
                        html,
                        uploadResult
                            .urlMap
                    );
            }

            /*
             * LINK POST HANDLING
             *
             * Only posts tagged exactly #link
             * get this behavior.
             *
             * A standalone URL is converted
             * into Ghost's official Bookmark
             * HTML structure.
             */
            const isLinkPost =
                tags.includes('#link');

            const bookmarkUrl =
                this
                    .conversionResult
                    .bookmarkUrl;

            if (
                isLinkPost &&
                bookmarkUrl
            ) {
                this.setStatus(
                    'Creating bookmark card...'
                );

                const bookmarkResult =
                    await api
                        .getBookmarkData(
                            bookmarkUrl
                        );

                if (
                    bookmarkResult.success
                ) {
                    const bookmarkHtml =
                        buildGhostBookmarkHtml(
                            bookmarkUrl,
                            bookmarkResult
                                .data
                        );

                    html =
                        replaceStandaloneUrlWithBookmark(
                            html,
                            bookmarkUrl,
                            bookmarkHtml
                        );
                } else {
                    /*
                     * Bookmark generation should
                     * never prevent the post from
                     * publishing.
                     *
                     * If Ghost cannot retrieve
                     * metadata, leave the original
                     * URL in place.
                     */
                    console.warn(
                        'Ghosty Posty: Unable to create bookmark:',
                        bookmarkResult.error
                    );

                    new Notice(
                        'Bookmark preview could not be created. Publishing the link normally.'
                    );
                }
            }

            this.setStatus(
                this.isUpdate
                    ? 'Updating post...'
                    : 'Creating post...'
            );

            /*
             * Determine published_at.
             */
            let publishedAt:
                string | undefined;

            if (
                this.editableStatus ===
                    'scheduled' &&
                this.editableScheduledDate
            ) {
                const localDate =
                    new Date(
                        this
                            .editableScheduledDate
                    );

                publishedAt =
                    localDate.toISOString();
            } else if (
                this.metadata
                    .publishedAt
            ) {
                publishedAt =
                    this.metadata
                        .publishedAt;
            }

            const emailOnly =
                this.deliveryMode ===
                'newsletter_only';

            /*
             * Build Ghost post payload.
             *
             * We're still sending HTML here.
             * Ghost recognizes the Bookmark
             * card markup and imports it.
             */
            const payload:
                GhostPostPayload = {
                posts: [
                    {
                        title:
                            this
                                .editableTitle,

                        html,

                        status:
                            this
                                .editableStatus,

                        visibility:
                            this
                                .editableVisibility,

                        ...(
                            this.metadata
                                .slug &&
                            {
                                slug:
                                    this
                                        .metadata
                                        .slug
                            }
                        ),

                        ...(
                            tags.length >
                                0 &&
                            {
                                tags:
                                    tags.map(
                                        name => ({
                                            name
                                        })
                                    )
                            }
                        ),

                        ...(
                            publishedAt &&
                            {
                                published_at:
                                    publishedAt
                            }
                        ),

                        ...(
                            featureImageUrl &&
                            {
                                feature_image:
                                    featureImageUrl
                            }
                        ),

                        ...(
                            this
                                .editableFeatured &&
                            {
                                featured:
                                    true
                            }
                        ),

                        ...(
                            emailOnly &&
                            {
                                email_only:
                                    true
                            }
                        ),

                        ...(
                            currentUpdatedAt &&
                            {
                                updated_at:
                                    currentUpdatedAt
                            }
                        )
                    }
                ]
            };

            /*
             * Newsletter delivery options.
             */
            const options:
                PublishOptions = {};

            if (
                this.deliveryMode !==
                    'post' &&
                this
                    .selectedNewsletterSlug
            ) {
                options.newsletterSlug =
                    this
                        .selectedNewsletterSlug;
            }

            /*
             * Create or update the post.
             */
            const result =
                this.isUpdate &&
                this.metadata.existing
                    ? await api
                        .updatePost(
                            this
                                .metadata
                                .existing
                                .id,
                            payload,
                            options
                        )
                    : await api
                        .createPost(
                            payload,
                            options
                        );

            if (result.success) {
                new Notice(
                    this.isUpdate
                        ? 'Post updated successfully!'
                        : 'Post published successfully!'
                );

                this.onSuccess(
                    result.post,
                    !this.isUpdate
                );

                this.close();
            } else {
                new Notice(
                    `Failed: ${result.error}`
                );

                this.setStatus(
                    `Error: ${result.error}`
                );

                this.resetButton();
            }
        } catch (error) {
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : 'Unknown error';

            new Notice(
                `Error: ${errorMessage}`
            );

            this.setStatus(
                `Error: ${errorMessage}`
            );

            this.resetButton();
        }
    }

    onClose() {
        const { contentEl } =
            this;

        contentEl.empty();
    }
}