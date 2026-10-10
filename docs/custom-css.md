# Custom CSS

**Settings → Preferences → Custom CSS** applies your own stylesheet on top of
Obby. Paste CSS into the box, or upload a `.css` file, then save.

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

So a stylesheet can never make Obby load anything from elsewhere (and leak
your IP), these are removed or disabled when saving and loading: `@import`,
any `url()` that isn't an inline `data:` URL, `image-set()`, and the legacy
`expression()`, `behavior:` and `-moz-binding` hooks. CSS escapes are decoded
first, so they can't be used to disguise them. Use `data:` URLs for images and
fonts.

## Sharing it between browsers

After a save, Obby keeps the stylesheet in that browser and also tries to
upload it with `PUT data/custom.css`, relative to where Obby is served. On
startup every browser loads that file, so one upload covers every browser.

The stock Docker image doesn't accept uploads: the `PUT` fails, the stylesheet
stays in that browser only, and the settings panel says so. To enable it, add
a location like this to the nginx config, and mount a writable directory
owned by the `nginx` user (uid 101) at `/usr/share/nginx/html/data`:

```nginx
location = /data/custom.css {
    root /usr/share/nginx/html;
    default_type text/css;
    add_header Cache-Control "no-cache";
    dav_methods PUT;
    client_max_body_size 6m;
    client_body_temp_path /tmp/nginx-put;
    # Only trusted networks may change the stylesheet.
    limit_except GET HEAD {
        allow 10.0.0.0/8;
        allow 172.16.0.0/12;
        allow 192.168.0.0/16;
        allow 100.64.0.0/10;
        deny all;
    }
}
```

Anyone who can send the `PUT` can change what every browser sees, so restrict
it to networks you trust.
