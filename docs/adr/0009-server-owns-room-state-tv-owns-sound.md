---
status: accepted
date: 2026-10-19
---

# 0009. The server owns the Room; the TV owns the sound

**English** · [Português (Brasil)](0009-server-owns-room-state-tv-owns-sound.pt-BR.md)

The Room's state (the Queue, whose Turn it is, the settings, the Intermission) lives on the server and goes to every device over WebSocket. The TV plays the song and reports where it is; phones only ask for actions. So phones and the TV never disagree, and a TV reloaded mid-song resumes where it was.

## Consequences

- Time-based phases, like the Intermission, are decided by the server; devices receive how much time is left and count down on their own, so their clocks never need to agree.
- Seeking is a request the server forwards to the TV, because only the TV knows the real position.
