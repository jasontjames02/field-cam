#!/bin/sh
# Self-signed certificate for the local fake Microsoft / OneDrive server.
cd "$(dirname "$0")" && openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 30 \
  -subj "/CN=fake" -addext "subjectAltName=DNS:jasontjames02.github.io,DNS:login.microsoftonline.com,DNS:graph.microsoft.com,DNS:upload.fake.test,DNS:download.fake.test"
