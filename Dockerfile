FROM python:3.11-slim

WORKDIR /app

ARG NODE_VERSION=20.19.0
ENV REFLEX_DIR=/app/.reflex
ENV REFLEX_USE_NPM=true

RUN apt-get update && apt-get install -y \
    unzip \
    curl \
    gcc \
    libpq-dev \
    xz-utils \
    ca-certificates \
    && ARCH="$(dpkg --print-architecture)" \
    && case "${ARCH}" in \
        amd64) NODE_ARCH='x64' ;; \
        arm64) NODE_ARCH='arm64' ;; \
        *) echo "Unsupported architecture: ${ARCH}" && exit 1 ;; \
    esac \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
    && rm /tmp/node.tar.xz \
    && node --version \
    && npm --version \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

RUN mkdir -p "$REFLEX_DIR" /app/.data \
    && reflex export --frontend-only --no-zip --env prod

RUN chmod +x start.sh

EXPOSE 8080

CMD ["./start.sh"]
