# Bridged users

Many communities relay their website shoutbox into IRC through a bot. The bot
posts every line with the person's name wrapped inside the text:

```text
Bot      03:47 PM
[mara] But I do agree with that
```

**Settings → Preferences → Bridged users** shows such a line as the person who
wrote it instead:

```text
mara  03:47 PM  via Bot
But I do agree with that
```

The name takes its own nick colour, consecutive lines from one person group
under one header, a mention inside the text counts as a mention, and reply and
copy use the person's name. The faint **via Bot** marker stays on every such
run, and hovering the name shows the bot's original line, because anyone can
type `[staff] send me your password` through a nick called Bot. The marker
cannot be switched off.

Nothing changes on the wire: Obby rewrites the line only in its own memory
when it arrives. Switch **Show bridged users as themselves** off to see lines
as the bot sent them.

## Where the rules come from

Each bot has its own format, so Obby needs to be told which bot speaks for
which network and how it wraps the name. **Bridge rules** has two parts, and
both are optional:

- **Load from a link**: the URL of a `.json` rules file. Obby downloads it
  every time it starts, so everyone who uses the same link gets updates. The
  last copy that loaded is kept, so it still applies when the host is down.
- **Your own rules**: paste JSON or upload a `.json` file. It's kept in this
  browser; a rule here replaces the linked rule for the same network and bot.

Both are stored in the browser, so each browser or device is set up once. Under
each source Obby shows how many rules loaded and how many it skipped.

## Sharing a rules file

Put the `.json` file somewhere with a stable link and share the link:

- The link must point to the **raw file**, not a preview page. On a GitHub
  gist, use the "Raw" link; on a self-hosted Gitea-style forge, use the API raw
  link (`/api/v1/repos/<owner>/<repo>/raw/<file>`), which sends the header
  below.
- The host must allow other sites to read the file, with the
  `Access-Control-Allow-Origin` header. If a host doesn't, Obby shows "Could
  not load this link".
- Loading the link contacts that host (and only that host), which sees the
  viewer's IP address like any web request. No cookies or referrer are sent.

## The file format

```json
{
  "version": 1,
  "rules": [
    { "host": "irc.lst.gg", "bot": "Bot", "formats": ["[{nick}] {text}"] },
    {
      "host": "irc.homiehelpdesk.net",
      "bot": "BBot",
      "formats": ["[{nick}] (WEB): {text}"]
    },
    {
      "host": "irc.reelflix.cc",
      "bot": "WALL-E",
      "formats": ["[Chatbox] {nick}: {text}"]
    },
    {
      "host": "irc.nebulance.io",
      "bot": "Sauron",
      "channels": ["#ant"],
      "formats": ["[SB] ({nick}): {text}", "[SB] {nick}: {text}"]
    },
    { "host": "irc.infinityhd.net", "nickFormat": "({nick})", "label": "web" }
  ]
}
```

- `host` (required): the network's real IRC host, lowercase. For networks
  behind a soju bouncer this is the network's own host, not the bouncer's. To
  find it, right-click the network in the server list → Inspect, and read
  `data-network-host` on the row.
- `bot`: the nick the bridge speaks as. Case and mode prefixes (`@`, `+`) do
  not matter. Required unless `nickFormat` is given.
- `formats`: one or more templates tried in order; the first that matches
  wins. Required with `bot`.
- `channels`: optional. When present, the rule applies only in these
  channels; otherwise in every channel on that host.
- `nickFormat`: for networks where web users join IRC themselves under a
  wrapped nick such as `(Jeditwo)`. The bare name is shown with the real nick
  on hover; the message text is untouched. Mutually exclusive with `bot`.
- `label`: the word shown in the marker for `nickFormat` rules ("via web").
  Default `web`; 1 to 32 characters, and a rule with an empty label is
  skipped, since the marker is never optional.
- `note`: free text, ignored by Obby.

Templates are literal text with placeholders:

- `{nick}`: the person's name, 1 to 32 characters without whitespace.
- `{text}`: the rest of the message. A message template must end with it.
- `{_}`: anything up to the next literal, thrown away, for example a rank in
  `»{nick} ({_})« {text}`. At most one per template.

A single space in a template matches any run of whitespace. Everything else
must match literally. IRC colour and formatting codes are removed before
matching, so a bot that colours its prefix still matches.

Templates are not regular expressions and never become one you can write by
hand: each compiles to a bounded pattern, so a rules file loaded from a link
cannot make Obby hang. A file is rejected as a whole when it is not JSON, not
`"version": 1`, larger than 1 MB or has more than 500 rules; a single invalid
rule is skipped and counted.

## Adding a bridge

Read a few lines from the bot and write what you see around the name, with
`{nick}` for the name and `{text}` for the message. Lines from the bot that
match no template, such as welcome messages or the second half of a split
post, stay as the bot's own lines.
