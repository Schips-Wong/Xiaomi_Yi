# Xiaomi Yi Control

## 基于Python的小蚁运动相机控制脚本

汉化：
```
Tiya Anlite
Schips.huang
```

ref : https://github.com/deltaflyer4747/Xiaomi_Yi 

## 程序说明

CC.pyw 主程序（Python 3脚本）

通过PC与相机使用WIFI连接，可控制选项：拍照，录像与实时预览，配置和文件管理

## Web 版（纯 JS 实现）

`web/` 目录是浏览器版控制台，功能与 `CC.pyw` 一一对应：按拍照 / 录像 / 实时预览、
拍摄模式与变焦、全部可写参数配置、文件浏览下载删除上传、
格式化 / 重启 / 恢复出厂 / 启用 Telnet、通信日志。

关于「纯 web」：浏览器没有任何 API 能直接发起 TCP 连接到相机的 7878 端口
（WebSocket 只能连 WS 服务，Direct Sockets 只在 Chrome 的 IWA 包里可用），
所以页面外面还需要一个本地中转进程。这一层用 Node.js 实现，整个项目就是纯 JS 技术栈：

```
cd web
npm install        # 装 ws（可选；不装也能跑，只是页面退化为 HTTP 轮询）
npm start          # 自动打开 http://127.0.0.1:8000
node server.mjs --port 8080 --no-browser
```

连上相机的 WiFi 后，在页面顶部填入相机 IP（默认 192.168.42.1，端口 7878）点「连接」即可。

- `web/index.html` 页面本体：样式与脚本全部内联，无框架、无构建、无 CDN
- `web/server.mjs` 本地中转：TCP 7878 客户端 + 静态页面 + REST 接口 + WebSocket 推送
- `web/package.json` npm 脚本与依赖

页面与中转之间的接口：`GET /api/status`、`POST /api/action`、`GET /api/download`、
`POST /api/upload`、`WS /ws`（相机状态实时推送，失败自动回退到 1.5 秒轮询）。

实时预览仍是 RTSP 流：页面只在相机上开启取流并给出 `rtsp://相机IP:554/live` 地址，
用 VLC / PotPlayer 打开即可，浏览器本身不能播放 RTSP。


## Standalone_scripts

### 配置参数

编辑`options.txt`中的配置项，再运行`Camera_set.py`脚本便可设置相机参数

`Camera_all_options.py`脚本会显示所有可选参数和值

`Camera_get.py`脚本获取目前相机的配置，可以将输出的结果和

先查：运行 Camera_get.py 看当前整体配置 → 觉得不够详细就跑 Camera_all_options.py，弄清每个参数有哪些合法取值（options.txt 里 # 注释掉的备选值其实就是从这里来的）。
再改：编辑 options.txt，把想要的取值那行去掉行首 #、把不想要的行加上 #（每类参数只能保留一行未注释，否则后面的会覆盖前面的）。
执行：运行 Camera_set.py，未注释的命令按顺序逐条下发到相机。

### 拍摄控制

Camera_photo.py脚本可以使相机拍摄一张照片

### 录制控制

Camera_record_start.py和Camera_record_stop.py脚本可以控制录像的开始与停止

### RTSP拉流控制

Camera_video_stream.py脚本将会打开实时预览，以便通过支持RTSP协议的软件查看（例如VLC软件）
