#!/usr/bin/env python3
# -*- coding: utf-8 -*-
#
# 作者 Andy（中文版）

# 功能：命令相机开始录像

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

# 发送开始录像命令
tosend = '{"msg_id":513,"token":%s}' %token
srv.send(tosend.encode("utf-8"))
srv.recv(512)
