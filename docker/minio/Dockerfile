# MinIO 本地镜像（社区版已不以 Docker 镜像形式分发，改为源码构建）
# 构建：docker compose -f docker/compose.yaml build minio
#
# MINIO_VERSION 使用 Go 模块伪版本（MinIO 的 RELEASE.* 标签不是合法 semver），
# 固定后构建可复现；升级时改为 proxy.golang.org/github.com/minio/minio/@latest 返回的版本。
#
# 网络受限时可通过构建参数覆盖：
#   --build-arg GOPROXY=https://goproxy.cn,direct
#   --build-arg HTTP_PROXY=http://host.docker.internal:7890 --build-arg HTTPS_PROXY=...
FROM golang:1.24-alpine AS builder

ARG MINIO_VERSION=v0.0.0-20260212201848-7aac2a2c5b7c
ARG GOPROXY=https://proxy.golang.org,direct
ENV CGO_ENABLED=0
RUN go install github.com/minio/minio@${MINIO_VERSION}

FROM alpine:latest
RUN apk add --no-cache ca-certificates curl
COPY --from=builder /go/bin/minio /usr/bin/minio

EXPOSE 9000 9001
ENTRYPOINT ["minio"]
CMD ["server", "/data", "--console-address", ":9001"]
