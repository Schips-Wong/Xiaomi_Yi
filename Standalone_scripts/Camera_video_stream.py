#!/usr/bin/env python3
# -*- coding: utf-8 -*-
#
# 作者 Andy（中文版）

# 功能：开启相机实时取流，配合 VLC 观看直播画面

import os, re, sys, time, socket
from settings import camaddr
from settings import camport

srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.connect((camaddr, camport))

# 向相机认证以获取令牌
srv.send('{"msg_id":257,"token":0}'.encode("utf-8"))

data = srv.recv(512).decode("utf-8", "ignore")
if "rval" in data:
	token = re.findall('"param": (.+) }',data)[0]
else:
	data = srv.recv(512).decode("utf-8", "ignore")
	if "rval" in data:
		token = re.findall('"param": (.+) }',data)[0]

# 请求开启实时视频流
tosend = '{"msg_id":259,"token":%s,"param":"none_force"}' %token
srv.send(tosend.encode("utf-8"))
srv.recv(512)
print("实时网络直播流已开启。")
print('打开 VLC，选择“媒体”->“打开网络串流”，并输入')
print('rtsp://%s/live' %camaddr)
print()
print("按 CTRL+C 结束本程序")

while 1:
	time.sleep(1)
