const apiUrl = document.querySelector("#apiUrl");
const bridgeUrl = document.querySelector("#bridgeUrl");
const token = document.querySelector("#token");
const message = document.querySelector("#message");
const openWorkspace = document.querySelector("#openWorkspace");

function updateWorkspaceLink() {
  try { openWorkspace.href = new URL(apiUrl.value.trim()).href; }
  catch { openWorkspace.href = "http://127.0.0.1:43120"; }
}

chrome.storage.local.get({ apiUrl: "http://127.0.0.1:43120", bridgeUrl: "ws://127.0.0.1:43120/extension", token: "" }).then((values) => {
  apiUrl.value = values.apiUrl;
  bridgeUrl.value = values.bridgeUrl;
  token.value = values.token;
  updateWorkspaceLink();
});

apiUrl.addEventListener("input", updateWorkspaceLink);

document.querySelector("#form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const api = new URL(apiUrl.value.trim());
    const bridge = new URL(bridgeUrl.value.trim());
    const local = ["127.0.0.1", "localhost", "::1"].includes(api.hostname);
    if (!local && api.protocol !== "https:") throw new Error("远程 Web 工作台必须使用 HTTPS");
    if (!local && bridge.protocol !== "wss:") throw new Error("远程执行通道必须使用 WSS");
    if (api.hostname !== bridge.hostname) throw new Error("Web 工作台与执行通道必须使用同一域名");
    const accessToken = token.value.trim();
    if (!local && accessToken.length < 24) throw new Error("插件连接码至少需要 24 个字符");
    if (!/^[A-Za-z0-9._~-]+$/.test(accessToken)) throw new Error("令牌只能包含字母、数字和 . _ ~ -");
    const granted = await chrome.permissions.request({ origins: [`${api.origin}/*`] });
    if (!granted) throw new Error("需要允许扩展访问这个 JobDeck 工作台");
    await chrome.storage.local.set({ apiUrl: api.href.replace(/\/$/, ""), bridgeUrl: bridge.href, token: accessToken });
    await chrome.runtime.sendMessage({ type: "reconnect" });
    updateWorkspaceLink();
    message.textContent = "已保存，扩展正在连接你的 JobDeck 账号空间。";
  } catch (error) {
    message.textContent = error.message;
  }
});
