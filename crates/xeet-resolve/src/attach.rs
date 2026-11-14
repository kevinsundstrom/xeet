// "Post video" / "Post photo" and direct twimg URLs in a draft.
//
// X's composer has two ways to give a draft media without uploading it:
//
//   - a status URL that names one of the post's media items — `/status/<id>/video/2`,
//     `/status/<id>/photo/1` (`quote-media-toggle-jMLU_r6g`,
//     `post-media-menu-item-jECN8x_w`). That is **"Post video"/"Post photo"**: the
//     item is attached to *this* post and credited to the post it came from. It is
//     **not** a quote, which is what a plain status URL becomes.
//   - a direct `video.twimg.com` / `pbs.twimg.com` URL pasted into the text: the
//     file itself is the attachment.
//
// Both are only attached to a draft that has no media of its own yet, and both
// end up as `post.media` with `Media::source_author` set when the original author
// is not the post's own.

use serde_json::Value;
use xeet_core::model::{Media, MediaKind};

use super::*;

/// A URL in a draft that X turns into post media rather than into a card.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Attachment {
    /// `/status/<id>/video/N` or `/status/<id>/photo/N`: media `index` of post `id`.
    StatusMedia { id: String, index: usize },
    /// `video.twimg.com/…`: a video file, with the size taken from its path.
    VideoFile { width: u32, height: u32 },
    /// `pbs.twimg.com/amplify_video_thumb/…` or `ext_tw_video_thumb/…`.
    VideoThumb,
    /// `pbs.twimg.com/tweet_video_thumb/…`.
    GifThumb,
    /// `pbs.twimg.com/media/…`.
    Photo,
}

/// Classifies a URL as a media attachment, or `None` when X would treat it as a
/// link (a card, a quote, anything else).
pub(crate) fn attachment_of(href: &str) -> Option<Attachment> {
    // A status URL only attaches media when it names an item; without the
    // suffix it is a quote.
    if let Some(reference) = post::status_ref(href) {
        return reference.media.map(|(_, index)| Attachment::StatusMedia {
            id: reference.id,
            index,
        });
    }
    let url = Url::parse(href)?;
    let path = url.path.as_str();
    match url.host.as_str() {
        "video.twimg.com" => {
            if !(path.ends_with(".mp4") || path.ends_with(".m3u8")) {
                return None;
            }
            let (width, height) = video_size(path).unwrap_or((1280, 720));
            Some(Attachment::VideoFile { width, height })
        }
        "pbs.twimg.com" => {
            if path.starts_with("/amplify_video_thumb/") || path.starts_with("/ext_tw_video_thumb/")
            {
                Some(Attachment::VideoThumb)
            } else if path.starts_with("/tweet_video_thumb/") {
                Some(Attachment::GifThumb)
            } else if path.starts_with("/media/") {
                Some(Attachment::Photo)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// `…/vid/avc1/864x1080/clip.mp4` → `(864, 1080)`.
///
/// X encodes the size in the path, so a video URL needs no request at all: the
/// stream is never fetched (`Attachment::VideoFile` has no bytes), only its size
/// is read here.
pub(crate) fn video_size(path: &str) -> Option<(u32, u32)> {
    let mut previous: Option<&str> = None;
    for segment in path.split('/') {
        if previous.is_some_and(|codec| matches!(codec, "avc1" | "vp9" | "hevc" | "h264")) {
            if let Some(size) = parse_size(segment) {
                return Some(size);
            }
        }
        previous = Some(segment);
    }
    // Any `WxH` segment, for the m3u8 master playlists and unusual paths.
    path.split('/').find_map(parse_size)
}

fn parse_size(segment: &str) -> Option<(u32, u32)> {
    let (width, height) = segment.split_once('x')?;
    if width.is_empty() || height.is_empty() {
        return None;
    }
    if !width.chars().all(|c| c.is_ascii_digit()) || !height.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let (width, height) = (width.parse::<u32>().ok()?, height.parse::<u32>().ok()?);
    if width == 0 || height == 0 {
        return None;
    }
    Some((width, height))
}

/// The media item of a fetched post, converted the way the model wants it.
///
/// `index` is 0-based; an out-of-range index falls back to the first item, which
/// is what X does when a share link's number no longer matches the post.
pub(crate) fn media_from_payload(tweet: &Value, index: usize) -> Option<(Media, Value)> {
    let entries = tweet.get("media_entities2")?.as_array()?;
    let entry = entries.get(index).or_else(|| entries.first())?;
    let width = entry
        .pointer("/original_info/width")
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    let height = entry
        .pointer("/original_info/height")
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    if width == 0 || height == 0 {
        return None;
    }
    let kind = match entry.get("type").and_then(Value::as_str) {
        Some("video") => MediaKind::Video,
        Some("animated_gif") => MediaKind::Gif,
        _ => MediaKind::Image,
    };
    let mut media = Media {
        kind,
        width,
        height,
        ..Media::default()
    };
    if let Some(alt) = entry.get("ext_alt_text").and_then(Value::as_str) {
        if !alt.is_empty() {
            media.alt = Some(post::well_formed(alt));
        }
    }
    if let Some(millis) = entry
        .pointer("/video_info/duration_millis")
        .and_then(Value::as_f64)
    {
        if millis > 0.0 {
            media.duration = Some((millis / 1000.0) as f32);
        }
    }
    Some((media, entry.clone()))
}

/// `https://video.twimg.com/…` and everything else X would not card.
pub(crate) fn is_media_url(href: &str) -> bool {
    attachment_of(href).is_some()
}

/// The image that goes with a `video.twimg.com` URL, when the draft also has one:
/// a `*_video_thumb` or `/media/` URL next to it is that video's poster, not a
/// second attachment.
pub(crate) fn poster_for_video(urls: &[(String, String)], video_index: usize) -> Option<usize> {
    for (index, (_, expanded)) in urls.iter().enumerate() {
        if index == video_index {
            continue;
        }
        match attachment_of(expanded) {
            Some(Attachment::VideoThumb) | Some(Attachment::Photo) => return Some(index),
            _ => {}
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Attaching
// ---------------------------------------------------------------------------

/// One item on its way to `post.media`.
struct Planned {
    /// The URL as written in the draft (the key of its `post.links` entry).
    written: String,
    /// What will be fetched for the bytes, if anything.
    media_href: Option<String>,
    /// The poster for a `video.twimg.com` item, when the draft supplies one.
    poster_href: Option<String>,
    kind: MediaKind,
    size: Option<(u32, u32)>,
    /// The original author, and the avatar URL to inline for it.
    source_author: Option<(xeet_core::model::Author, Option<String>)>,
    note: &'static str,
}

/// "Post video", "Post photo", or a direct `twimg` URL in a draft.
///
/// Runs after the post's own payload is known (a draft has none) and before the
/// quote rule, and only when the draft has no media or poll of its own — X never
/// mixes an embedded item with an upload.
pub(crate) async fn attach_from_text<F, L, C, K>(ctx: &Ctx<'_, F, L, C, K>, resolved: &mut Resolved)
where
    F: Fetch,
    L: Lookup,
    C: Cache,
    K: Clock,
{
    if !resolved.post.media.is_empty() || resolved.post.poll.is_some() {
        return;
    }
    let urls = text_urls(&resolved.post.text);
    if urls.is_empty() {
        return;
    }
    // A status URL that names a media item wins: that is X's own "Post video" /
    // "Post photo", and the post it points at is the only way to the item.
    let status = urls
        .iter()
        .find_map(|(written, expanded)| match attachment_of(expanded) {
            Some(Attachment::StatusMedia { id, index }) => Some((written.clone(), id, index)),
            _ => None,
        });
    if let Some((written, id, index)) = status {
        attach_status_media(ctx, resolved, &written, &id, index).await;
        return;
    }
    // Otherwise, direct `twimg` URLs: a video file (never downloaded), a video or
    // GIF thumbnail, and up to `max_media` photos.
    let mut planned: Vec<Planned> = Vec::new();
    let mut used: std::collections::BTreeSet<usize> = std::collections::BTreeSet::new();
    for (index, (written, expanded)) in urls.iter().enumerate() {
        if used.contains(&index) || planned.len() >= ctx.opts.limits.max_media {
            continue;
        }
        let Some(attachment) = attachment_of(expanded) else {
            continue;
        };
        match attachment {
            Attachment::StatusMedia { .. } => {}
            Attachment::VideoFile { width, height } => {
                // X puts the poster next to the file; take it as this item's
                // bytes instead of drawing the same picture twice.
                let poster = poster_for_video(&urls, index).map(|poster| {
                    used.insert(poster);
                    urls[poster].1.clone()
                });
                planned.push(Planned {
                    written: written.clone(),
                    media_href: None,
                    poster_href: poster,
                    kind: MediaKind::Video,
                    size: Some((width, height)),
                    source_author: None,
                    note: "direct X video URL attached as post media",
                });
            }
            Attachment::VideoThumb | Attachment::GifThumb | Attachment::Photo => {
                planned.push(Planned {
                    written: written.clone(),
                    media_href: Some(expanded.clone()),
                    poster_href: None,
                    kind: if attachment == Attachment::GifThumb {
                        MediaKind::Gif
                    } else if attachment == Attachment::VideoThumb {
                        MediaKind::Video
                    } else {
                        MediaKind::Image
                    },
                    size: None,
                    source_author: None,
                    note: "direct X media URL attached as post media",
                });
            }
        }
    }
    // Every item is pushed first (the grid's width — and so the variant — is
    // the count the post draws), then all their bytes are fetched in one wave
    // and applied in the draft's order.
    let (content_width, dpr) = slot_scale(&ctx.opts);
    let mut items: Vec<AttachItem> = Vec::with_capacity(planned.len());
    for plan in planned {
        let (width, height) = plan.size.unwrap_or((0, 0));
        let entry = Media {
            kind: plan.kind,
            width,
            height,
            ..Media::default()
        };
        push_item(
            resolved,
            plan,
            entry,
            None,
            None,
            content_width,
            dpr,
            &mut items,
        );
    }
    attach_items(ctx, resolved, items).await;
}

/// The draft's URL entities, as `(written, with a scheme)`.
fn text_urls(text: &str) -> Vec<(String, String)> {
    xeet_text::parse(text)
        .entities
        .into_iter()
        .filter_map(|entity| match entity.kind {
            xeet_text::EntityKind::Url { expanded, .. } => Some((entity.text, expanded)),
            _ => None,
        })
        .collect()
}

/// `/status/<id>/video/<N>`: the media item, credited to the post it came from.
async fn attach_status_media<F, L, C, K>(
    ctx: &Ctx<'_, F, L, C, K>,
    resolved: &mut Resolved,
    written: &str,
    id: &str,
    index: usize,
) where
    F: Fetch,
    L: Lookup,
    C: Cache,
    K: Clock,
{
    // The item's own post: its payload has the dimensions, the duration, the alt
    // text and the author to credit. One quote level is enough (we only read
    // media), so the budget is 1.
    let handle = crate::post::status_handle(written);
    let page = match post_from_page(ctx, id, handle.as_deref(), 1).await {
        Ok(page) => page,
        Err(error) => {
            resolved.warnings.push(format!(
                "the post behind {written} could not be resolved: {}",
                error.message()
            ));
            return;
        }
    };
    let Some((media, entry)) = media_from_payload(&page.tweet, index) else {
        resolved.warnings.push(format!(
            "{written}: that post has no media at position {}",
            index + 1
        ));
        return;
    };
    // The author to credit: the media's own `source_user_results` when the item
    // was itself embedded, else the post's author. Never our own author.
    let source_user = entry
        .pointer("/source_user_results/result")
        .or_else(|| page.tweet.pointer("/core/user_results/result"));
    let mut media = media;
    let mut avatar_url = None;
    if let Some(user) = source_user {
        let author = post::author_from_user(user);
        let own = resolved.post.author.handle.trim();
        if !author.handle.is_empty() && (own.is_empty() || !author.handle.eq_ignore_ascii_case(own))
        {
            avatar_url = user
                .pointer("/avatar/image_url")
                .and_then(Value::as_str)
                .map(str::to_string);
            media.source_author = Some(author);
        }
    }
    let plan = Planned {
        written: written.to_string(),
        media_href: entry
            .get("media_url_https")
            .and_then(Value::as_str)
            .map(str::to_string),
        poster_href: None,
        kind: media.kind,
        size: Some((media.width, media.height)),
        source_author: media
            .source_author
            .clone()
            .map(|author| (author, avatar_url)),
        note: "post media attached from its post",
    };
    // This item already has the payload's duration and alt text: `push_item`
    // keeps them, and the fetch only fills `Media::data`.
    let durations = (media.duration, media.alt.take());
    let (content_width, dpr) = slot_scale(&ctx.opts);
    let mut items = Vec::with_capacity(1);
    push_item(
        resolved,
        plan,
        media,
        durations.0,
        durations.1,
        content_width,
        dpr,
        &mut items,
    );
    attach_items(ctx, resolved, items).await;
}

/// The slot geometry the caller asked for: `(content width, dpr)`.
fn slot_scale(opts: &Options) -> (f32, f32) {
    let dpr = if opts.dpr.is_finite() && opts.dpr > 0.0 {
        opts.dpr
    } else {
        2.0
    };
    let content_width = (opts.width.clamp(100.0, 600.0) - 32.0).max(1.0);
    (content_width, dpr)
}

/// One item on its way into `post.media`, with the fetches its slot needs.
struct AttachItem {
    slot: usize,
    plan: Planned,
    /// The payload's own duration and alt text, for the post that supplied the
    /// media (`None` for a direct `twimg` URL).
    duration: Option<f32>,
    alt: Option<String>,
    jobs: Vec<AttachJob>,
}

/// One image fetch for an item: the item's bytes, or its source author's avatar.
struct AttachJob {
    url: String,
    variant: &'static str,
    role: String,
    /// The source author's picture, not the item's own bytes.
    avatar: bool,
    /// The URL the variant came from, when the CDN names a different one: that
    /// is what the fallback chain ends at.
    base: Option<String>,
}

/// Pushes one item into `post.media` and plans the fetches its slot needs.
///
/// The item is pushed first because the grid's slot width — and so the variant —
/// depends on how many items the post draws, exactly as the one-at-a-time loop
/// computed it after each push.
#[allow(clippy::too_many_arguments)]
fn push_item(
    resolved: &mut Resolved,
    plan: Planned,
    entry: Media,
    duration: Option<f32>,
    alt: Option<String>,
    content_width: f32,
    dpr: f32,
    items: &mut Vec<AttachItem>,
) {
    let slot = resolved.post.media.len();
    resolved.post.media.push(entry);
    let count = resolved.post.media.len().max(1);
    let variant = media::variant_for(media::slot_width(count, content_width, Layout::Grid), dpr);
    let mut jobs = Vec::new();
    // The poster, else the item's own URL. A URL the CDN cannot name stops here,
    // as it did before the media fetch (and then draws no avatar either).
    let mut named = true;
    if let Some(href) = plan.poster_href.as_ref().or(plan.media_href.as_ref()) {
        match media::variant_url(href, variant) {
            Some(url) => jobs.push(AttachJob {
                base: (url != *href).then(|| href.clone()),
                url,
                variant,
                role: format!("media:{slot}"),
                avatar: false,
            }),
            None => named = false,
        }
    }
    // The original author's picture, at X's 16 px attribution-chip size.
    if named {
        if let Some((_, Some(avatar))) = plan.source_author.as_ref() {
            let avatar_variant = media::avatar_variant_for(media::AVATAR_COMPACT_CSS, dpr);
            if let Some(href) = media::avatar_url_for(avatar, avatar_variant) {
                jobs.push(AttachJob {
                    base: None,
                    url: href,
                    variant: avatar_variant,
                    role: format!("media:{slot} source avatar"),
                    avatar: true,
                });
            }
        }
    }
    items.push(AttachItem {
        slot,
        plan,
        duration,
        alt,
        jobs,
    });
}

/// Fetches every item's bytes in one wave, then fills the items in the draft's
/// order.
///
/// The items are independent, so their variant fetches (and attribution
/// avatars) go out together; applying the results in order keeps the roles, the
/// `source.media` keys and the warnings identical to the one-at-a-time path.
async fn attach_items<F, L, C, K>(
    ctx: &Ctx<'_, F, L, C, K>,
    resolved: &mut Resolved,
    items: Vec<AttachItem>,
) where
    F: Fetch,
    L: Lookup,
    C: Cache,
    K: Clock,
{
    let fetches: Vec<BoxedFetch<'_>> = items
        .iter()
        .flat_map(|item| item.jobs.iter())
        .map(|job| {
            let fut: BoxedFetch<'_> = Box::pin(async move {
                let mut warnings = Vec::new();
                let (asset, used) = match &job.base {
                    Some(base) => {
                        fetch_image_fallback(
                            ctx,
                            base,
                            &job.url,
                            job.variant,
                            &job.role,
                            &mut warnings,
                        )
                        .await
                    }
                    None => (
                        fetch_image(ctx, &job.url, job.variant, &job.role, &mut warnings).await,
                        job.url.clone(),
                    ),
                };
                (asset, used, warnings)
            });
            fut
        })
        .collect();
    let results = join_all(fetches).await;
    let mut results = results.into_iter();

    let mut warnings: Vec<String> = Vec::new();
    for item in &items {
        for (job, (asset, _used, job_warnings)) in item.jobs.iter().zip(results.by_ref()) {
            warnings.extend(job_warnings);
            let Some(asset) = asset else {
                continue;
            };
            if let Some(entry) = resolved.post.media.get_mut(item.slot) {
                if job.avatar {
                    if let Some(author) = entry.source_author.as_mut() {
                        author.avatar = asset.data.clone();
                    }
                } else {
                    entry.data = asset.data.clone();
                    // A thumbnail's own pixels are the only size we have for it.
                    if entry.width == 0 || entry.height == 0 {
                        entry.width = asset.width;
                        entry.height = asset.height;
                    }
                    if let Some(duration) = item.duration {
                        entry.duration = Some(duration);
                    }
                    if let Some(alt) = &item.alt {
                        entry.alt = Some(alt.clone());
                    }
                }
            }
            if ctx.opts.media {
                // Keyed by the variant URL, as before, even when the bytes came
                // from the original.
                resolved.media.insert(job.url.clone(), asset);
            }
        }
        resolved.warnings.append(&mut warnings);
        note_link(resolved, &item.plan);
    }
}

/// `post.links[url]` with no card: the URL is an attachment, not a link.
fn note_link(resolved: &mut Resolved, plan: &Planned) {
    let display = display_url(&plan.written);
    resolved.post.links.insert(
        plan.written.clone(),
        xeet_core::model::LinkMeta {
            display: Some(display),
            ..Default::default()
        },
    );
    resolved.links.insert(
        plan.written.clone(),
        ResolvedLink {
            meta: resolved.post.links[&plan.written].clone(),
            chain: Vec::new(),
            final_url: plan.written.clone(),
            tags: Default::default(),
            image_url: None,
            image: None,
            notes: vec![plan.note.to_string()],
            cached: false,
        },
    );
}
