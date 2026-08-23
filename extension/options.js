const apiUrl = document.querySelector("#apiUrl");
const bridgeUrl = document.querySelector("#bridgeUrl");
const token = document.querySelector("#token");
const message = document.querySelector("#message");

chrome.storage.local.get({ apiUrl: "http://127.0.0.1:43120", bridgeUrl: "ws://127.0.0.1:43120/extension", token: "" }).then((values) => {
  apiUrl.value = values.apiUrl;
  bridgeUrl.value = values.bridgeUrl;
  token.value = values.token;
});

document.querySelector("#form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await chrome.storage.local.set({ apiUrl: apiUrl.value.trim(), bridgeUrl: bridgeUrl.value.trim(), token: token.value.trim() });
  await chrome.runtime.sendMessage({ type: "reconnect" });
  message.textContent = "已保存，扩展正在连接本地工作台。";
});
