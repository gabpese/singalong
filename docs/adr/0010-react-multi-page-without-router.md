---
status: accepted
date: 2026-10-19
---

# 0010. React, with one page per screen and no router

**English** · [Português (Brasil)](0010-react-multi-page-without-router.pt-BR.md)

The web app moved from hand-written JavaScript to React because the Room, TV and Stage screens are drawn from the state instead of updating the DOM by hand, and because React is the most requested UI library in the roles the owner applies for. It stays as four Vite pages (`index.html`, `room.html`, `tv.html`, `stage.html`) with no router: the URLs, the TV's QR code and the host links had to stay the same, and each screen stands on its own. The migration ran behind 34 end-to-end tests written first, which passed unchanged before and after.
