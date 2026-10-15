Frozen EPIC-04 checkpoint/WAL v1.0 fixture with one completed synthetic HTTP200 page.
The immutable v1 schemas, rolling WAL hash, checkpoint checksum and field order are
intentionally retained. EPIC-05 reader must restore the URL, result and discovery summary
as discovery-only; it must not infer analysis coverage or change schemaVersion.
No credentials, HTML, target requests or production artifacts.
