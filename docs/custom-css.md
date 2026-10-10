# Custom CSS

**Settings → Preferences → Custom CSS** applies a stylesheet on top of Obby.
It has two parts, and both are optional:

- **Load from a link**: the URL of a `.css` file. Obby downloads it every time
  it starts, so everyone who uses the same link gets your updates. The last
  copy that loaded is kept, so it still applies when the host is down.
- **Your own CSS**: paste CSS or upload a `.css` file. It's kept in this
  browser and applied after the linked file, so it can override it.

Both are stored in the browser, so each browser or device is set up once.

## Sharing a stylesheet

Put the `.css` file somewhere with a stable link and share the link:

- The link must point to the **raw file**, not a preview page. On a GitHub
  gist, use the "Raw" link. On a file host like Zipline, use the raw/direct
  link.
- The host must allow other sites to read the file, with the
  `Access-Control-Allow-Origin` header. GitHub raw links and Zipline send it.
  If a host doesn't, Obby shows "Could not load this link".
- Loading the link contacts that host (and only that host), which sees the
  viewer's IP address like any web request. No cookies or referrer are sent.

## Styling individual networks

Every row in the server list carries the network's real IRC host:

```html
<div class="obby-server-row" data-network-host="irc.example.net" title="My name"></div>
```

For networks behind a soju bouncer this is the network's own host, not the
bouncer's. The expanded list is `.obby-server-rail[data-expanded="true"]`, and
the name inside a row is `.obby-server-name`. For example, to show a logo
instead of a network's name:

```css
.obby-server-rail[data-expanded="true"]
  .obby-server-row[data-network-host="irc.example.net"]
  .obby-server-name {
  font-size: 0;
  height: 18px;
  max-width: 150px;
  background: url("data:image/svg+xml,...") left center / contain no-repeat;
}
```

## What is removed

So a stylesheet can never make Obby load anything else (and leak your IP),
these are removed or disabled in both the linked file and your own CSS:

- `@import`
- any `url()` that isn't an inline `data:` URL
- `image-set()`, `image()` and `src()`, which take a plain string as a URL
- the legacy `expression()`, `behavior:` and `-moz-binding` hooks

Line endings are normalised and CSS escapes decoded first, the same way the
browser does, so neither can disguise them. Use `data:` URLs for images and
fonts.
