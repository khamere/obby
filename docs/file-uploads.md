# Uploading images to your own file host

Pasting or dropping an image into the message box uploads it and sends the
link. Normally the file goes to the host the IRC network advertises. If the
network has none, or you would rather keep your screenshots on your own
server, point Obby at your own [Zipline](https://zipline.diced.sh) under
**Settings → Preferences → File uploads**.

## Setup

1. In Zipline, open your user menu → **Settings** and copy your **token**.
2. In Obby, enter the address of your Zipline (for example
   `https://img.example.com`) and paste the token, then **Save**.

Both are stored in this browser only, so each browser or device is set up
once. When a host is configured, it is used for every network, even ones that
offer their own file host. **Remove** switches back to the network's host.

Zipline v3 and v4 both work. Other uploaders that take a multipart `file`
field on `POST <address>/api/upload` and answer with the file URL (in the
`Location` header, a `url` field or the body) work too.

## The host must allow uploads from Obby

The upload is a cross-origin request from the Obby site to your Zipline, so
Zipline has to answer the browser's CORS preflight. If it does not, the
upload fails with "Could not reach the file host" and nothing is sent. Add
these headers on the reverse proxy in front of Zipline for `/api/upload`:

```text
Access-Control-Allow-Origin: https://your-obby.example
Access-Control-Allow-Headers: authorization, content-type
Access-Control-Allow-Methods: POST, OPTIONS
```

and answer `OPTIONS` requests with `204`. Replace the origin with the address
you open Obby from.

## Keep the token private

Anyone with the token can upload as you. Only enter it on devices you
control, and regenerate it in Zipline if a device is lost.

Images from your host count as a trusted source for previews, the same as a
network's own file host.
