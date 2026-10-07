# @dougschaefer/webflow

A [Swamp](https://swamp.club) extension that wraps the Webflow Data API v2 for
site publishing, CMS collection schema discovery, CMS item CRUD with bulk
publish, and page metadata management including SEO and Open Graph fields. The
shared API client handles pagination automatically for large collections and
authenticates via an OAuth bearer token stored in your Swamp vault.

## Models

### `@dougschaefer/webflow-site`

Webflow sites with custom domains, locale configuration, and publishing status.
The `publish` method pushes a site live to its custom domains without touching
the Webflow UI.

| Method    | Description                                          | Arguments                            |
| --------- | ---------------------------------------------------- | ------------------------------------ |
| `list`    | List all sites accessible to the authenticated token | None                                 |
| `get`     | Get detailed site information                        | `siteId`                             |
| `publish` | Publish a site to specified (or all) custom domains  | `siteId`, `domains` (optional array) |

### `@dougschaefer/webflow-collection`

CMS collection schemas with full field definitions. Useful for discovery before
creating items, as the field schema tells you exactly which fields exist, which
are required, and what types they expect.

| Method | Description                                 | Arguments      |
| ------ | ------------------------------------------- | -------------- |
| `list` | List all CMS collections for a site         | `siteId`       |
| `get`  | Get a collection with its full field schema | `collectionId` |

### `@dougschaefer/webflow-cms-item`

Full CRUD on CMS collection items with bulk publish support. This is where
automated content pipelines land, as you can create items, update field data
with partial patches, publish batches live, and remove items that have been
verified for deletion.

The staged methods (`list`, `get`, `create`, `update`, `bulkUpdate`,
`bulkCreate`, `sync`) work on the staged copy of each item and store it as the
`item` resource. The live methods (`listLive`, `getLive`, `createLive`,
`updateLive`) work on the published copy through Webflow's `/items/live`
endpoints and store it as a separate `liveItem` resource, so the staged and live
state of the same slug never overwrite each other. `updateLive` edits published
content without a site publish. `unpublish` takes the listed items off the live
site but keeps the staged items; use `delete` or `batchDelete` to remove them
entirely. `delete`, `batchDelete`, `publish` and `unpublish` store a record of
what they did as the `deleteResult`, `publishResult` and `unpublishResult`
resources. `bulkUpdate` fails, after recording the items Webflow did return, if
any requested item is missing from the response.

| Method        | Description                                                                                                                   | Arguments                                                                                                              |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `list`        | List all staged items in a collection                                                                                         | `collectionId`                                                                                                         |
| `get`         | Get a specific staged item by ID                                                                                              | `collectionId`, `itemId`                                                                                               |
| `create`      | Create a staged item (does not publish; use `publish` or `createLive`); returns the existing item if the slug is taken        | `collectionId`, `fieldData`, `isDraft` (optional)                                                                      |
| `update`      | Partial update on staged item field data                                                                                      | `collectionId`, `itemId`, `fieldData`                                                                                  |
| `delete`      | Delete an item (verify IDs first)                                                                                             | `collectionId`, `itemId`                                                                                               |
| `batchCreate` | Create up to 100 items in one request                                                                                         | `collectionId`, `items` (array of `{fieldData, isDraft}`)                                                              |
| `batchDelete` | Delete up to 100 items in one request, primary locale only (verify IDs first)                                                 | `collectionId`, `itemIds` (array)                                                                                      |
| `bulkUpdate`  | Partial update of up to 100 staged items in one request                                                                       | `collectionId`, `items` (array of `{id, fieldData, isDraft?, isArchived?, cmsLocaleId?}`)                              |
| `bulkCreate`  | Create one or more items, optionally across several locales, via `/items/bulk`                                                | `collectionId`, `items` (array of fieldData), `cmsLocaleIds` (optional), `isDraft` (optional), `isArchived` (optional) |
| `publish`     | Publish one or more items live                                                                                                | `collectionId`, `itemIds` (array)                                                                                      |
| `listLive`    | List all published items in a collection                                                                                      | `collectionId`                                                                                                         |
| `getLive`     | Get the published copy of an item                                                                                             | `collectionId`, `itemId`                                                                                               |
| `createLive`  | Create an item and publish it immediately; skips the create if the slug already exists                                        | `collectionId`, `fieldData`                                                                                            |
| `updateLive`  | Partial update of a published item without re-publishing                                                                      | `collectionId`, `itemId`, `fieldData`                                                                                  |
| `unpublish`   | Unpublish up to 100 items in the primary locale only; the staged items are kept and become `isDraft: true` (verify IDs first) | `collectionId`, `itemIds` (array)                                                                                      |
| `sync`        | Re-list staged items and refresh stored resources                                                                             | `collectionId`                                                                                                         |

### `@dougschaefer/webflow-page`

Page-level operations covering metadata retrieval, SEO title and description
management, Open Graph tag configuration, and static DOM content access.

| Method           | Description                                             | Arguments                                                                                         |
| ---------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `list`           | List all pages for a site                               | `siteId`                                                                                          |
| `get`            | Get page metadata                                       | `pageId`                                                                                          |
| `updateSettings` | Update title, slug, SEO metadata, and Open Graph fields | `pageId`, plus optional `title`, `slug`, `seoTitle`, `seoDescription`, `ogTitle`, `ogDescription` |
| `getContent`     | Retrieve static DOM content for a page                  | `pageId`                                                                                          |

## Installation

```bash
swamp extension pull @dougschaefer/webflow
```

## Setup

The extension authenticates with a Webflow OAuth bearer token. You can generate
a site-scoped API token from **Site Settings > Apps & Integrations** in the
Webflow dashboard, though site-scoped tokens have limited permission coverage.
For full Data API v2 access, register a Webflow App at
[developers.webflow.com](https://developers.webflow.com) and run the OAuth flow
with these scopes:

```
sites:read sites:write cms:read cms:write pages:read pages:write
```

Store the token in a Swamp vault:

```bash
swamp vault create my-vault
swamp vault put my-vault "webflow-token=your-token"
```

Then create model instances that reference the vault. Site operations require
the Webflow site ID, which you can find under **Site Settings > General > Site
ID** in the Webflow dashboard.

```bash
swamp model create @dougschaefer/webflow-site my-site \
  --global-arg 'token=${{ vault.get(my-vault, webflow-token) }}'

swamp model create @dougschaefer/webflow-collection my-collections \
  --global-arg 'token=${{ vault.get(my-vault, webflow-token) }}'

swamp model create @dougschaefer/webflow-cms-item my-cms \
  --global-arg 'token=${{ vault.get(my-vault, webflow-token) }}'

swamp model create @dougschaefer/webflow-page my-pages \
  --global-arg 'token=${{ vault.get(my-vault, webflow-token) }}'
```

The `baseUrl` defaults to `https://api.webflow.com/v2` and should not need to be
changed.

## API Compatibility

The extension targets Webflow Data API v2 exclusively. It covers the headless
REST operations (sites, collections, items, pages) and does not cover Designer
API capabilities (style manipulation, element building, design tokens), which
require a live Webflow Designer session.

The pagination client follows Webflow's offset-based pagination with a page size
of 100, fetching all pages automatically so method callers always receive
complete result sets. A page that returns HTTP 429 is retried once after the
`Retry-After` wait (capped at 30 seconds), and an empty page ends the walk.

## License

MIT — see [LICENSE.txt](LICENSE.txt)
