---
section: fixed
---

- **Dictation in a very noisy room no longer sends the room's hum as speech when it starts.** With Local (Whisper), ElevenLabs or OpenAI, the hum of a very noisy room (such as a loud air conditioner or a fan close to the microphone) still counted as speech for about two seconds after the microphone opened, so that hum went to the engine with your first phrase. A microphone that starts with a faint hiss instead of complete silence had the same problem for about five seconds. Now, when the start is loud, dictation tells the room from your voice before deciding what is speech: speech pauses between words, a room's hum doesn't. If you are already talking when the microphone opens, you are still heard, and if it is the room, its level is set from up to two seconds of it. The faint hiss some microphones send while they start no longer counts as the room.
