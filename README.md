# 🎯 Twitch Auto Redeem

A Chromium extension that auto-redeems a Twitch channel points reward the moment its cooldown ends.

## ✨ What it does

- You pick one reward per channel. The extension remembers the pick for that channel.
- Flip the loop on and a 1-second tick watches the cooldown. The redeem fires when the cooldown ends, plus 0 to 3 seconds of random delay.
- Arming while the reward is already available redeems within seconds.
- Rewards with no cooldown never spam. The loop redeems them exactly once, then goes idle until you re-arm it by toggling the loop off and on, or clicking Redeem now.
- The loop waits when you lack points, when the reward is paused, disabled, or out of stock, and when the stream is offline. It shows the reason and resumes on its own once the reward is redeemable again.
- Two tabs of the same channel can never double-redeem. A cross-tab lock lets one redeem through.

## 🚀 Install

The extension runs in Chromium browsers: Brave, Chrome, Edge, Opera, and Vivaldi. The steps are the same in all of them.

1. Open the extensions page of your browser:
   - Brave: `brave://extensions`
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
   - Opera: `opera://extensions`
   - Vivaldi: `vivaldi://extensions`
2. Turn on Developer mode.
3. Click Load unpacked and select the folder you put this repo in. That is the folder that contains `manifest.json`.
4. Open a Twitch channel you are logged into.
5. The Auto Redeem pill appears in the bottom right corner. Drag it anywhere, then click it to open the card.
6. Pick a reward and turn on Auto-redeem loop.

Firefox is not supported. It cannot run this extension without changes to the manifest and the bridge script.

## 🖱️ The panel

The pill shows a status dot and a short label:

- green dot: armed or ready
- amber dot: waiting
- red dot: error
- purple pulsing dot: redeem in flight

Labels include `⏱ 4:12` for the next redeem, `need pts`, `waiting`, `done ✓`, `off`, and `error`.

The card holds the channel name, your points balance, the reward list with cost and cooldown countdowns, the loop toggle, Redeem now, a status line, and a log of the last 20 redeems with time and cost.

## 🛠️ How it works

The extension uses your logged-in Twitch web session from the page itself. A bridge script runs in the page's main world, reads channel points data from Twitch's internal GraphQL API, and sends the redeem request the same way the Twitch website does. It also mints Twitch's Client-Integrity token from the page context when the server asks for it.

Because of that, a tab of the channel must stay open somewhere. A muted background tab in another window works fine.

When you leave the channel, the loop pauses and the stored timer stays intact. The status turns to paused, and the loop resumes when you come back.

## ⚠️ Things to know

Chrome and Brave throttle timers in hidden tabs. While the loop is armed, the extension holds a Web Lock so Brave does not throttle it aggressively. For the best timing, keep the channel tab audible and keep twitch.tv out of any memory saver that freezes hidden tabs.

Twitch changes their internal API without notice. The bridge tries several query and mutation variants, so most changes should keep working.

## 🩹 Troubleshooting

If you see "Could not read channel points", Twitch changed something the bridge could not absorb. Open DevTools by pressing F12 and look for `[tar]` and `[tar-bridge]` messages in the Console.

If a redeem fails, the card's log keeps the last failures. Set `DEBUG = true` at the top of `content.js`, reload the extension in `brave://extensions`, and check the console for details.

To reset everything, remove the extension from `brave://extensions`, or clear its `tar.*` storage keys.

## 📁 Files

| File | Role |
| --- | --- |
| `manifest.json` | Extension manifest, MV3 |
| `content.js` | Page controller: tick loop, scheduling, storage, locking |
| `panel.js` | Pill and card UI, isolated in a shadow root |
| `page-bridge.js` | Main-world bridge to Twitch's GraphQL API, plus the response sniffer |
| `background.js` | Service worker that runs the cross-tab redeem lock |
| `icons/` | Toolbar icons |

## ⚖️ Fair use note

Twitch's Terms of Service, section 10, prohibits automated access to their services, and this extension talks to Twitch's internal web API the same way the site itself does. Public reports of account bans from viewer-side channel points tools are rare, but the terms are against automation, so use this at your own discretion. It is deliberately low-frequency: at most one redeem per cooldown window.
