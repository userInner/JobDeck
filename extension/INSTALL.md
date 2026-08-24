# 安装 JobDeck Chrome 扩展

1. 解压下载的 ZIP。
2. 在 Chrome 打开 `chrome://extensions`。
3. 开启右上角“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择解压后的 `JobDeck-Chrome-Extension` 文件夹。
6. 打开扩展设置，填写 JobDeck 工作台的 HTTPS 地址、WSS 地址和访问令牌。
7. 在扩展侧边栏中仅授权需要操作的招聘网站。

远程示例：

```text
Web 工作台：https://jobdeck.example.com
执行通道：wss://jobdeck.example.com/extension
访问令牌：部署服务器时设置的 JOBDECK_ACCESS_TOKEN
```

不要把访问令牌、简历、聊天记录、验证码、钱包助记词或私钥发给其他人。
