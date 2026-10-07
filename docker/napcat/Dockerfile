# 本地构建版 NapCat 镜像
#
# 为什么要自己构建：官方镜像的 tag 走在 <code>mlikiowa/napcat-docker</code>，而国内
# 直连 registry-1.docker.io 会超时；免费加速站只能解析 manifest、拿不到大 layer。
# 这里只把 ubuntu:22.04 当底座（体积小，加速站能正常交付），
# Linux QQ 从腾讯 CDN 取、NapCat 本体从 GitHub 取 —— 这两个源在国内都通。
#
# 构建完后 tag 成 mlikiowa/napcat-docker:latest，docker-compose.yml 无需改动。
#
# ⚠️ **上面那句就是 `docker-compose.yml` 里 `image: mlikiowa/napcat-docker:latest` 的含义**
#    （2026-10-05 · 第 10 轮 · 开源前审查 H-07 的一处更正）：它不是"一个浮动 tag 的
#    第三方镜像"，而是**本文件构建出来的本地镜像的名字**。别去把它改成 digest ——
#    那会让"镜像已存在就直接用"退化成"必须先 pull 到那个 digest"，
#    而本机实测连 `registry-1.docker.io` 都是 `Bad Gateway`，Docker 路线会当场不可用。
#
#    真正的外部输入只有三个，**都已经钉住**：
#      · `NAPCAT_VERSION` —— `docker-compose.yml` 的 build.args（当前 v4.18.28）
#      · LinuxQQ 的 deb —— 版本写死在 `fetch-linuxqq.sh` 的回退 URL 里
#      · 底座 ubuntu:22.04 —— 见下（**未钉 digest，只记录**）
#
# ⚠️ 底座镜像的 digest（本机实测解析，2026-10-05，供需要时手工钉）：
#      docker.m.daocloud.io/library/ubuntu:22.04
#        amd64 → sha256:08ea48a03a3e78ebc7cd526e6a275053223aadd88bfc09cc49b06d5281525fde
#        arm64 → sha256:30dfd7fe96f97c5f5ddf388ce8d098aa509644ad68fdef67244fb71b8169ffcb
#    为什么**只记录不强制**（本轮的决定，理由要留档）：
#      ① 这是**第三方加速站**（daocloud）。钉死 digest 之后，一旦它换了缓存策略
#         就是构建以一个很隐晦的错误失败 —— 而这是 README §2 标为唯一推荐的路线；
#      ② apt 依赖本来就没钉版本，单钉底座给不出可复现性（它只是把"一半可复现"当全部）；
#      ③ 钉了之后要**有人定期 bump** 才能拿到安全更新，否则会长期停在一个有已知问题的底座上。
#    → 想钉：改成 `docker.m.daocloud.io/library/ubuntu:22.04@sha256:<对应架构那个>`，
#      并把日期与来源补进 `THIRD-PARTY-NOTICES.md` §5。

ARG BASE_IMAGE=docker.m.daocloud.io/library/ubuntu:22.04
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Shanghai

# 换成国内 apt 源，否则装这一堆依赖要等到天亮。
# 实测下载同一份 Packages.gz 的速度（本机）：
#   mirrors.huaweicloud.com  5.8 MB/s  ← 用它
#   mirrors.163.com          3.7 MB/s
#   mirrors.ustc.edu.cn      3.1 MB/s
#   mirrors.cloud.tencent.com 1.35 MB/s
#   mirrors.aliyun.com        0.15 MB/s ← 慢 37 倍，别用
# 两个坑：
#   1) arm64 的 ubuntu 镜像默认用 ports.ubuntu.com（不是 archive.ubuntu.com），三个域名都要换；
#      huawei 同时镜像了 ubuntu-ports，所以路径不用改。
#   2) 这里必须用 http:// 而不是 https:// —— 底座镜像里还没装 ca-certificates，
#      走 https 会因证书不受信任直接失败（apt 包本身有 GPG 签名，http 不影响完整性）。
ARG APT_MIRROR=http://mirrors.huaweicloud.com
RUN set -eux; \
    find /etc/apt -type f \( -name '*.list' -o -name '*.sources' \) -print -exec sed -i \
      -e "s|https\?://archive\.ubuntu\.com|${APT_MIRROR}|g" \
      -e "s|https\?://security\.ubuntu\.com|${APT_MIRROR}|g" \
      -e "s|https\?://ports\.ubuntu\.com|${APT_MIRROR}|g" \
      {} + ; \
    echo "--- 替换后的 apt 源 ---"; \
    grep -rhE '^(deb|URIs)' /etc/apt/sources.list /etc/apt/sources.list.d/ 2>/dev/null | sort -u

RUN apt-get update && apt-get install -y --no-install-recommends \
      libnss3 \
      libnotify4 \
      libsecret-1-0 \
      libgbm1 \
      xvfb \
      libasound2 \
      fonts-wqy-zenhei \
      gnutls-bin \
      libglib2.0-dev \
      libdbus-1-3 \
      libgtk-3-0 \
      libxss1 \
      libxtst6 \
      libatspi2.0-0 \
      libx11-xcb1 \
      ffmpeg \
      unzip \
      dbus-user-session \
      curl \
      jq \
      gosu \
      tzdata \
      ca-certificates \
    && echo "${TZ}" > /etc/timezone \
    && ln -sf /usr/share/zoneinfo/${TZ} /etc/localtime \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --no-log-init -d /app napcat
WORKDIR /app

# entrypoint.sh 与 templates/ **不随仓库提交**
#
# ⚠️ 为什么（2026-10-05 开源前审查 · S-06）：NapCat 用的是
#    **Limited Redistribution License** —— 未经主作者明确许可禁止复制与分发，
#    且"为再分发而做的修改不得以公开形式发布"。而 `THIRD-PARTY-NOTICES.md`
#    声明的合规边界正是「不链接、不修改、不复制它的任何代码」。
#    把它们提交进来会让那份声明变成伪陈述。
# ⇒ 构建前先跑 `./fetch-docker-assets.sh`（与 fetch-napcat.sh / fetch-linuxqq.sh
#    同一步骤）。本机已有的话脚本会跳过，不会覆盖你的改造。
# ⚠️ 缺了它们**构建会失败**（COPY 找不到文件）—— 这是刻意的：
#    宁可早失败，也不要出现"镜像起来了但行为不对"。
COPY entrypoint.sh /app/

# NapCat 本体：直接用本地文件构建，不再在镜像里联网下载。
# GitHub Releases 在国内单线程只有 30-50 KB/s 且频繁断流，先跑
# ./fetch-napcat.sh（8 段并行，28 MB 约 2 分钟）拿到包再构建，既快又可复现。
COPY NapCat.Shell.zip /app/NapCat.Shell.zip
RUN set -eux; \
    unzip -tq /app/NapCat.Shell.zip > /dev/null; \
    ls -lh /app/NapCat.Shell.zip

# Linux QQ 安装包：同样用本地文件构建。
# 腾讯 CDN 的路径里带随机 hash 且会轮换，而且实测对当前网络直接返回 403
#（Server: Lego Server，不是代理拦截）。已确认这不是链接失效 ——
# 同域名下不存在的路径返回 404，而配置里那条 QQNTV2 路径稳定 403，属访问策略拒绝，
# 调 UA / Referer / Range 均无效。可用的替代路径是 QQNT/beta：
#   https://qqdl.gtimg.cn/qqfile/QQNT/9.9.35/beta/1763096b/linuxqq_3.2.33-52892_arm64.deb
#（3.2.33-52892 在 NapCat Linux 白名单内，207 MB，已写入 fetch-linuxqq.sh 作为回退源）
# 先用 ./fetch-linuxqq.sh 拿到包，拿不到就按 README 用浏览器手动下载后放进本目录。
COPY linuxqq.deb /tmp/linuxqq.deb
RUN set -eux; \
    dpkg -i --force-depends /tmp/linuxqq.deb; \
    rm -f /tmp/linuxqq.deb; \
    test -x /opt/QQ/qq; \
    echo "==> QQ 安装完成"; \
    ls -d /opt/QQ; \
    grep -o '"version": *"[^"]*"' /opt/QQ/resources/app/package.json || true

# 把 QQ 的 Electron 入口指向 NapCat 加载器
RUN set -eux; \
    chmod +x /app/entrypoint.sh; \
    echo "(async () => {await import('file:///app/napcat/napcat.mjs');})();" > /opt/QQ/resources/app/loadNapCat.js; \
    sed -i 's|"main": "[^"]*"|"main": "./loadNapCat.js"|' /opt/QQ/resources/app/package.json; \
    grep '"main"' /opt/QQ/resources/app/package.json

# 单独 COPY 目录：混在一条 COPY 里会把目录内容摊平到 /app 下，
# 而 entrypoint 用的是 /app/templates/$MODE.json 这个路径。
# 放最后一层，改动它不会让前面几百 MB 的层失效。
COPY templates /app/templates/

VOLUME /app/napcat/config
VOLUME /app/.config/QQ

ENTRYPOINT ["bash", "entrypoint.sh"]

# ⚠️ **这个容器必须以 root 启动，且不能 `cap_drop: [ALL]`** —— 这是对本项目开源前审查
#    「M-03：容器降权」那两条建议的**否决记录**（2026-10-05 · 第 10 轮）。
#    审查报告建议"Dockerfile 末尾加 `USER napcat`" + compose 加 `cap_drop: [ALL]` /
#    `security_opt: [no-new-privileges]`。照做会**把容器打坏**，证据在 `entrypoint.sh`：
#      · 前半段全是 root 专属动作：`mount --bind` 伪装 cgroup / mountinfo / DMI / NSpid
#        （NapCat 的**反检测措施**，挂不上就有被风控的风险）、`hostname`、
#        `usermod` / `groupmod` / `chown -R /app`；
#      · 后半段用 **`gosu napcat`** 降权跑 Xvfb 与 QQ —— 那一步需要 CAP_SETUID / CAP_SETGID，
#        被 `cap_drop: [ALL]` 拿掉之后 QQ **根本起不来**，而容器**不会报错**，只是没有 QQ。
#    ⇒ 真正的降权点就是 `entrypoint.sh` 里那句 `gosu`（它本来就是这么设计的）；
#      Dockerfile 末尾再加一道 `USER` 是**重复**，而且会挡住前面那些 root 动作。
#      → 要收紧这个容器的权限，得先给 entrypoint 写出最小权限清单并逐条实测 ——
#        那是独立的一件事（已登记为待裁决项）。
#
#    ⚠️ 本轮**只做了有证据的那一条**：compose 的三个端口收回回环（`docker-compose.yml`）。
#      容器权限这一条没有做，因为本机没有"起容器实测"的条件（要 pull 底座 + 装 207 MB 的
#      LinuxQQ），而在没有实测的地方照抄一条会打坏运行时的建议，正是本项目反复在修的错。
ENTRYPOINT ["bash", "entrypoint.sh"]
