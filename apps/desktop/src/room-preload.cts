// Runs inside the Room's pages (the TV and the Host): makes getUserMedia use the microphone chosen in the app's settings.
// The deviceId comes from the main process (it only applies when the page chose no device); "ideal" (not "exact") so it falls
// back to the default microphone when the chosen one was disconnected.
import electron = require('electron');

const { ipcRenderer, webFrame } = electron;
const id: string = ipcRenderer.sendSync('sg:mic-id');
if (id) {
  webFrame.executeJavaScript(`(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints) => {
      if (constraints && constraints.audio) {
        const audio = constraints.audio === true ? {} : constraints.audio;
        // when the page already chose a device (a TV with several microphones), its choice wins; the settings' is only the default
        if (!audio.deviceId) constraints = { ...constraints, audio: { ...audio, deviceId: { ideal: ${JSON.stringify(id)} } } };
      }
      return original(constraints);
    };
  })();`);
}
