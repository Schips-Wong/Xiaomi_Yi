#!/usr/bin/env python3
# -*- coding: utf-8 -*-
#
# 作者 Andy（中文版）

# 功能：按 options.txt 中的命令逐条设置相机参数
#       以 # 开头的行会被跳过，去掉行首的 # 即可启用对应的设置

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

filet = open("options.txt","r", encoding="utf-8").read()
if "\r\n" in filet:
	filek = filet.split("\r\n")
else:
	filek = filet.split("\n")

# 逐行读取命令并填充令牌后发送
for line in filek:
	if len(line) > 5:
		if not line.startswith("#"):
			tosend = line %token
#			print(tosend)
			srv.send(tosend.encode("utf-8"))
			srv.recv(512)
#			print(srv.recv(512).decode("utf-8", "ignore"))
#			print()
