# swamp-webflow

Webflow Data API v2 extension for [Swamp](https://swamp.club) — site publishing, CMS content management, page metadata, and SEO operations, all backed by OAuth bearer auth and vault-secured credentials.

## What This Does

This extension gives Swamp native visibility into your Webflow sites. Instead of bouncing between the Webflow dashboard and your automation tooling, you get four purpose-built models that track site state, CMS structure, content items, and page metadata as first-class Swamp resources.

Everything goes through Webflow's v2 REST API. No browser sessions, no Designer plugins, no mystery. The token comes from your vault, the data lands in your resource graph, and CEL expressions wire it all together.

## Models

### `@user/webflow-site`

Your Webflow sites — domains, locales, publishing status. The `publish` method pushes live to your custom domains without touching the Webflow UI.

| Method | What It Does |
|--------|-------------|
| `list` | Enumerate all sites accessible to your token |
| `get` | Pull detailed site info by ID |
| `publish` | Push a site live to specified (or all) custom domains |

### `@user/webflow-collection`

CMS collection schemas — the structural backbone of your Webflow content. Useful for discovery and for understanding what fields are available before you start creating items.

| Method | What It Does |
|--------|-------------|
| `list` | List all CMS collections for a site |
| `get` | Get a collection with its full field schema |

### `@user/webflow-cms-item`

The workhorse. Full CRUD on CMS collection items — create content, update it, publish it live, or remove it. This is where automated content pipelines land.

| Method | What It Does |
|--------|-------------|
| `list` | List all items in a collection |
| `get` | Get a specific item by ID |
| `create` | Create a new item (draft or published) |
| `update` | Partial update on item field data |
| `delete` | Remove an item (verify IDs first) |
| `publish` | Push items live by ID |

### `@user/webflow-page`

Page-level operations — metadata, SEO titles, Open Graph tags, and DOM content retrieval. Handy for SEO campaigns and content audits.

| Method | What It Does |
|--------|-------------|
| `list` | List all pages for a site |
| `get` | Get page metadata |
| `updateSettings` | Update title, slug, SEO, and Open Graph fields |
| `getContent` | Retrieve static DOM content for a page |

## Installation

Copy the `extensions/models/webflow/` directory into your Swamp repo:

```
your-repo/
  extensions/
    models/
      webflow/
        _client.ts
        site.ts
        collection.ts
        cms_item.ts
        page.ts
```

Swamp discovers the models automatically on next startup.

## Credentials

The extension expects a Webflow OAuth bearer token stored in your vault:

```bash
swamp vault put my-vault "webflow-token=<your-token>"
```

Create model instances with the vault reference:

```bash
swamp model create @user/webflow-site my-site \
  --global-arg 'token=${{ vault.get(my-vault, webflow-token) }}'

swamp model create @user/webflow-collection my-collections \
  --global-arg 'token=${{ vault.get(my-vault, webflow-token) }}'

swamp model create @user/webflow-cms-item my-cms \
  --global-arg 'token=${{ vault.get(my-vault, webflow-token) }}'

swamp model create @user/webflow-page my-pages \
  --global-arg 'token=${{ vault.get(my-vault, webflow-token) }}'
```

### Getting a Token

The site-scoped API tokens from Webflow's dashboard have limited permission coverage. For full Data API access, register a Webflow App at [developers.webflow.com](https://developers.webflow.com) and run the OAuth flow with these scopes:

```
sites:read sites:write cms:read cms:write pages:read pages:write custom_code:read custom_code:write assets:read assets:write
```

## What This Doesn't Do

This extension covers Webflow's headless Data API — the stuff that works from a terminal with no browser in sight. It does not cover the Designer tools (style manipulation, element building, design token management), which require a live Webflow Designer session with the MCP Bridge App active. Those are interactive capabilities, not automation targets.

## Requirements

- [Swamp](https://swamp.club) with extension model support
- Webflow account with API access
- OAuth bearer token with appropriate scopes

## License

MIT
