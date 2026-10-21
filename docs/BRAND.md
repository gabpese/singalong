---
date: 2026-10-16
target: apps/web, apps/desktop/ui, PRD.md
status: direction, palette B and logo approved by the owner on 2026-10-16; applied to the interface (web and installable app) in release 1.4.0
---

# Singalong: brand concept

**English** · [Português (Brasil)](BRAND.pt-BR.md)

Written for: the product owner, to settle the direction before any new round of interface work.

## 1. The verdict in one paragraph

The interface looked "AI-made" for a reason that comes before any font or color: **it had no brand idea**. The 1.4.0 brief asked for "Cyber-Club / Dark Arcade" and a "waiting for players" video-game screen, and that is what was built. But the PRD describes something else: a karaoke **at home, among friends, with no subscription and no closed catalog**, where the TV is the stage and the phone is the remote. Nobody there is a "player", and the room is not a club. As long as the metaphor is wrong, any palette will look like a template, because there is nothing for it to come from.

## 2. A critique of the identity at the time

- **[HIGH] The metaphor (video game / club) contradicts the product.**
  - **Evidence:** `PRD.md` §3 calls people host and singer/guest, while `Lobby.tsx` and `tvp.lobbyTitle` used game-lobby language.
  - **Proposal:** replace the metaphor with one born from real use (section 4). `[< 1 day]` to decide; the rest follows.
  - **Trade-off:** loses the "gamer" appeal the brief asked for; gains coherence and something nobody else has.
- **[HIGH] Nothing belonged only to Singalong.**
  - **Evidence:** `style.css` was a display font, a coral and dark cards; change the name and it fits any app. The one truly distinctive trait, the word-by-word lyric fill (`.current .w`, `lyrics-view.ts`), was treated as a detail.
  - **Proposal:** build the brand around two things only this product does: **the lyrics lighting up word by word** and **"now it is your turn"**.
  - **Trade-off:** a more specific (less "safe") brand, recognizable in a single screenshot.
- **[MEDIUM] The icon and the logo told another story.**
  - **Evidence:** `public/icons/singing.svg` is a vinyl/turntable (it suggests a DJ or a player, not singing), and `apps/desktop/ui/icon.png` was yellow next to a coral app, as the welcome-screen capture showed.
  - **Proposal:** one logo, used on the site, in the app, the tray and the installer (section 6). `[< 1 week]`
- **[MEDIUM] `welcome.png` still carried the old palette** (blue, purple and yellow) and appeared on the Home page and in the app.
  - **Proposal:** redo it after the palette is decided, not before. `[< 1 day]`
- **[MEDIUM] The voice of the copy wavered.** "You are the host: you choose the order" (instructional), "Isolating the band…" (playful) and "Applause for you" (generic) do not sound like the same person. Proposal: section 5.
- **[LOW] Reactions are system emoji** (`lib/reactions.ts`), off-brand. Proposal: an own set of five, drawn together with the logo.
- **[GOOD]** The duet uses color **and** shape (circle, square, diamond) and passed axe. That is a brand decision (accessible without fuss) and should become a principle. The tokens live in one file (`theme-bridge.css`), so changing the identity costs days, not weeks.

## 3. What the interface should convey (in order of importance)

1. **"It is ours."** Trust comes from the interface being simple and honest, with no tricks. The brand **never mentions price, subscriptions or ads**: the copy talks about singing, not about terms.
2. **"You do not need to be a singer."** It is a place for amateur singers, **very well looked after**. The care shows in the finish (alignment, type, empty states, messages), never in a professional-show pose. Nobody should feel they must earn the stage.
3. **"Everyone gets in."** Joining a room takes seconds and asks for no sign-up. Nothing on screen should look made for insiders.
4. **"Now it is your turn."** On any screen, from across the room or one-handed, you can tell whose turn it is and who is next.
5. **"No pressure."** The score is for fun (it is marked beta). Nobody is exposed or compared in a humiliating way.

**What the brand is not:** gamer, nightclub, corporate, "platform", or "AI assistant".

## 4. Core idea

**"Pass the mic."** (*Passa o microfone.*)

Karaoke at home is a microphone passed from hand to hand. The brand is about that passing: the lyrics light up word by word (the light moves from one word to the next), and the turn moves from one person to the next (the light moves from one person to the next). The look is a **neighborhood gig poster, at night**: paper and ink, a living room at night, with a single spotlight.

Why this and not a generic "cozy living room": coziness alone becomes the default look of any "warm" app. The poster gives the TV a format of its own (the current song as the headline) and is hard to produce on autopilot.

**Attributes:** warm, collective, direct, generous, playful without being childish.

## 5. Voice and copy

- Brazilian Portuguese, informal, short sentences, verb first. Speak like someone inviting people into the room, not like a manual.
- No strings of exclamation marks, no "Oops!", no "Applause for you". Humor is small and specific to the moment.
- Own vocabulary: **sala, vez, fila, palco, roda** (room, turn, queue, stage, circle) and **Jukebox**. The Jukebox is where the prepared songs live, and that is its name throughout the app (the screen used to say "Músicas já processadas"; it now says Jukebox). Avoid: player, match, session, platform, processing, library.
- No price: never "free", "no subscription", "no ads" or "zero cost" in any text in the app or on the Home page.
- Before and after:
  - "Aguardando cantores…" (Waiting for singers…) → keep. Short and right.
  - "Isolando a banda…" (Isolating the band…) → keep. The best line in the app, and it shows the tone: technique told as a scene.
  - "Acabou! Aplausos para você." (It is over! Applause for you.) → "Acabou. Quem é o próximo?" (It is over. Who is next?)
  - "Você é o anfitrião: escolhe a ordem, pula e pausa." → "Você manda na ordem: pula, pausa, escolhe quem canta." (You run the order: skip, pause, choose who sings.)

## 6. Visual direction (recommended) and alternatives

**Recommended: "Neighborhood poster at night".**
- **Color (palette B, approved):** night `#16110f`, cream paper `#f0e4cd`, tomato `#e0432c` (the interface's accent ink) and mustard `#e8a933`, which is **support only** (logo, posters, icon details) and never becomes a button or an interface state. The duet keeps turquoise, violet and yellow, because they are functional.
- **Type:** headings in a heavy, condensed poster grotesque (candidate: Archivo, with a width axis; alternative: keep Bricolage Grotesque, already installed). Body and interface in Geist. Two families, nothing else.
- **Logo:** "singalong" in lowercase, heavy, in two inks (cream with a slight misregistration in tomato, like cheap printing). At the top right, **outside the letters**, the **"AO VIVO" (ON AIR) sign**, like the ones outside a studio while it records: tilted, with a double border and screws, a little worn (scratches, one letter flickering) and **blinking irregularly**. It lights up when the room is live. Tidy: worn, but working. **Icon:** a black vinyl with a red label and a microphone in front, on a cream paper square (a poster sticker). Files: `brand/mark.svg`, `brand/mark-dark.svg`; the preview is `brand/preview.html`.
- **Texture:** grainy paper, rough edges, mustard tape, a halftone of red dots in one corner, a slight tilt. Two-ink printing; no glass, gradients or glow (the sign is the only "glow", because it is a real sign).
- **Imagery:** no stock photos. Any image is an own illustration in two inks (cream and red) on the dark background.
- **Motion:** only two things really move, and both are the brand: the word fill and the turn passing (a quick poster cut). Everything else stays still.

**Alternatives (and why not):**
- **"Living room at night"** (amber and cream, lamp light): pretty and safe, but it is what every "cozy" app does, and it gives the TV no format of its own. Plan B.
- **"Cassette tape and retro marquee"**: has personality, but it is a nostalgia cliché that ages and pulls the app toward "aesthetic" rather than "use".

## 7. How each screen applies the idea

- **Home:** the front door. Two choices, one dominant ("start the party") and one quiet ("join with a code"), and a short line about singing any song with friends (without mentioning price).
- **TV:** the poster. The current song is the headline, readable from afar; one element at a time; "who is singing" and "who is next" always legible at 4 m.
- **Phone:** the room's remote. One main action per screen, big targets, thumb reach, readable in low light (it is a party at night).
- **Installable app:** backstage. Quieter and utilitarian; the same type and color, without decoration.

## 8. The owner's decisions (settled on 2026-10-16)

| Decision | Answer |
|---|---|
| Who it is for | Friends, family, bars and events. Even in a bar or an event, the users are friends and family, so the tone is the same |
| Humor in the voice | A little |
| Mention price (free, no subscription) | No. The brand does not talk about money |
| Name | Singalong |
| Brand languages | Portuguese; English and Spanish follow the interface translation |
| Icon | Vinyl (nostalgia), now with a microphone, to say karaoke |
| Jukebox | The name of the place for prepared songs, throughout the app (another nod to how people used to listen to music) |
| Visual direction | Neighborhood poster at night, approved; logo with the "on air" sign approved as an idea |

## 9. Summary

- **Confidence:** high that the video-game metaphor was wrong (the PRD says the opposite). Medium on the "neighborhood poster" direction, the best bet, which only a test with 2 or 3 real people at a party confirms. Low on the exact red until it passes contrast.
- **The three actions, if only three can happen:**
  1. Approve the logo (draft in `brand/`). `[< 1 day]`
  2. Draw the logo and the single icon, and replace `singing.svg`, `icon.png` and the favicon. `[< 1 week]`
  3. Redesign only the TV as a poster (the most watched and most distinctive screen), before touching the rest. `[< 1 week]`

## 10. Execution plan

1. **Phase 1, decision (done):** section 8 answered; only the logo approval was left.
2. **Phase 2, foundation (1 week):** new tokens in `theme-bridge.css` (and the app's copy), fonts, logo, icon, favicon and a redone `welcome.png`.
3. **Phase 3, screens (1 to 2 weeks):** TV, then phone, then Home, then the installable app, with screenshots and axe at every step.
4. **Phase 4, validation:** put the TV and a phone in a room with people who do not know the project and ask "whose turn is it?" and "what is this?", without explaining.

## 11. What has been applied (2026-10-16)

- **Tokens:** palette B in `theme-bridge.css` (and in the app's copy). On screen the tomato is `#ea5a3f` (it passes contrast with dark text); on paper it darkens to `#c2371f`. The logo files use `#e0432c`.
- **Logo:** the `ui/Logo.tsx` component (the word in two inks plus the blinking "AO VIVO" sign, translated to "LIVE" and "EN VIVO"). It appears where the sign stays legible: the Home page and the TV poster. At small sizes the mark is used (`/brand/mark.svg`): favicon, room header, app icon, tray and installer (`build/icon.ico` with 7 sizes and a 1024 px `build/icon.png`, rebuilt by `scripts/make-icon.ts` from `brand/mark.svg`).
- **Home:** the party card is a poster (paper, tape, halftone, "Passa o microfone."), with "Join a room" and "Download the app" beside it. The old image (`welcome.png`) left the Home page; in its place, the mark taped up like a poster.
- **TV:** the waiting screen is a poster on the wall (logo, "Aguardando cantores…", the QR code with a stamp shadow, the code and the singers as they arrive). While playing, the queue became a paper note with tape, the singer's name has misregistered ink and the lyrics card got the halftone in a corner.
- **Phone:** the tab and the list of prepared songs are called **Jukebox**; the mark sits in the room header.
- **Installable app:** the same tokens and fonts, the mark in place of the yellow icon, the welcome screen with the mark taped up as a poster ("Passa o microfone.") and the import card called Jukebox.
- **Still pending:** `welcome.png` (still in the old palette) is no longer used anywhere; either it is redone with new screenshots or it leaves the repository. Reactions are still emoji.
- **Adjustments of 2026-10-16 (later):**
  - **Red instead of tomato**, which looked orange. Three strengths of the same red, for contrast: `#d62828` to fill (buttons, the active tab), with light text `#fff8ee` on top; `#ff6b6b` as text and lines on the dark (the lyrics lighting up, the "AO VIVO" sign, links); `#b91c1c` on paper. The mark files (`brand/mark.svg`) and the app icons were redone in the same red.
  - **Language by flags:** Brazil, United States and Spain, in SVG (flag emoji do not show on Windows); the language name is in the label and the tooltip.
  - **Avatars with personality:** every phone in the waiting room becomes a [blobatar](https://github.com/Alain00/blobatar) creature (MIT, no dependencies), made from the name and drawn in the app itself (no name goes to a third-party server). They breathe and blink; people who ask for reduced motion see them still.
  - **No limit of singers per room:** the server does not limit how many phones join. The poster shows at least 4 spots (open slots) and at most 7 in one row; beyond that, the last one becomes "+N".
  - **The singer's creature** also appears next to the name in "Cantando agora" and "Próximo" on the TV, in the TV's queue, on the playing song and in the phone's queue. In an accepted duet both appear, side by side (with the invite still pending, only the one who added the song). Only the "Cantando agora" one on the TV moves; in lists they stay still. On dark backgrounds the creature gets a cream sticker outline, because some tones are dark; on paper, the stamp shadow.
