These self-signed certificate and key are synthetic local test fixtures for
shop.example.com, not deployment credentials. They are trusted only by the internal
test transport. Production uses system certificate verification and has no TLS bypass.
Regenerate after expiry with:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout fixture.key -out fixture.crt \
  -days 3650 -subj '/CN=shop.example.com' -addext 'subjectAltName=DNS:shop.example.com'
```
