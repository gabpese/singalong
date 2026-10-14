// Roda dentro das páginas da sala (TV e anfitrião): faz o getUserMedia usar o microfone escolhido nas configurações do app.
// O deviceId vem do processo principal (só entra quando a página não escolheu um aparelho); "ideal" (e não "exact") para cair no microfone padrão se o escolhido foi desconectado.
const { ipcRenderer, webFrame } = require('electron');

const id = ipcRenderer.sendSync('sg:mic-id');
if (id) {
  webFrame.executeJavaScript(`(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints) => {
      if (constraints && constraints.audio) {
        const audio = constraints.audio === true ? {} : constraints.audio;
        // se a página já escolheu um aparelho (a TV com vários microfones), vale o dela; o das configurações é só o padrão
        if (!audio.deviceId) constraints = { ...constraints, audio: { ...audio, deviceId: { ideal: ${JSON.stringify(id)} } } };
      }
      return original(constraints);
    };
  })();`);
}
