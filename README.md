# htmltpostman

> CLI tool to convert ApiDoc HTML documentation (specifically optimized for Apiato / Laravel 9+) into a full-featured Postman Collection v2.1.0 with real live API response capture.

## Highlights
- **100% Zero External Dependencies**: Built with native Node.js 18+ (`fetch`, `vm`, `readline`, `fs`).
- **Smart HTML Parser**: Automatically parses and normalizes embedded ApiDoc documentation data directly from `.html` files.
- **Auto Admin Authentication**: Automatically logs in to `{{base_url}}/v1/clients/web/login` using admin credentials to retrieve Bearer tokens.
- **Smart Dependency-Graph Live Runner**:
  - Automatically runs list `GET` endpoints first (e.g. `/v1/users`, `/v1/domains`).
  - Auto-crawls and indexes real live IDs (both numeric and hashed IDs).
  - Automatically invokes detail `GET /:id` with real discovered IDs.
  - Safely invokes up to 20 `PATCH` requests with real IDs and documentation sample bodies.
  - Injects live captured responses (`status`, `headers`, formatted JSON `body`) directly into the Postman collection.
- **Global CLI**: Can be linked globally via `npm link` and run anywhere as `htmltpostman`.

## Installation

Clone the repository and link globally:

```bash
git clone https://github.com/hieubkbk10-hue/htmltopostman.git
cd htmltopostman
npm link
```

## Usage

### Interactive Mode
```bash
htmltpostman
```

### Command Line Mode
```bash
# Full live run with response capture
htmltpostman --html "./docs.html" --base-url "https://api.example.com"

# Custom admin credentials and output
htmltpostman --html "./docs.html" --base-url "https://api.example.com" --email "admin@example.com" --password "secret" --output "./my-collection.postman_collection.json"

# Using Bearer token directly
htmltpostman --html "./docs.html" --base-url "https://api.example.com" --token "eyJhbG..."

# Offline / Dry-run mode (no network calls, creates Postman collection directly from HTML)
htmltpostman --html "./docs.html" --no-live
```
