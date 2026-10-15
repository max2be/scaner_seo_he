export interface UrlSource { readonly kind:'sitemap'|'crawl'|'seed'|'backend'; discover():AsyncIterable<{url:string; source:string}>; }
// Concrete sources are EPIC-03; this is a typed extension point.
