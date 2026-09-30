#!/usr/bin/env bash
set -euo pipefail

readonly REPOSITORY="takeshi7502/vless5gtiktok"
readonly DEFAULT_REF="main"
readonly INSTALL_DIR="/opt/free-gateway"
readonly CONFIG_DIR="/etc/free-gateway"
readonly BINARY_PATH="/usr/local/bin/free-gateway"
readonly SERVICE_PATH="/etc/systemd/system/free-gateway.service"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root."
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "This installer requires systemd."
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This installer currently supports Debian and Ubuntu (apt-get) only."
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  apt-get update
  apt-get install -y curl ca-certificates
fi

if ! command -v go >/dev/null 2>&1; then
  echo "Installing the Go compiler required to build free-gateway..."
  apt-get update
  apt-get install -y golang-go
fi

ref="${FREE_GATEWAY_REF:-${DEFAULT_REF}}"
if [[ ! "${ref}" =~ ^[A-Za-z0-9._/-]+$ ]]; then
  echo "FREE_GATEWAY_REF contains invalid characters."
  exit 1
fi
base_url="https://raw.githubusercontent.com/${REPOSITORY}/${ref}/gateway"

install -d -m 0755 "${INSTALL_DIR}" "${CONFIG_DIR}" /var/lib/free-gateway
if ! id -u free-gateway >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/free-gateway --shell /usr/sbin/nologin free-gateway
fi
chown free-gateway:free-gateway /var/lib/free-gateway

echo "Downloading free-gateway source from ${REPOSITORY}@${ref}..."
curl --fail --show-error --silent --location --proto '=https' --tlsv1.2 \
  "${base_url}/free-gateway.go" -o "${INSTALL_DIR}/free-gateway.go"
curl --fail --show-error --silent --location --proto '=https' --tlsv1.2 \
  "${base_url}/free-gateway.service" -o "${SERVICE_PATH}"
curl --fail --show-error --silent --location --proto '=https' --tlsv1.2 \
  "${base_url}/free-gateway.env.example" -o "${CONFIG_DIR}/free-gateway.env.example"

echo "Building free-gateway..."
CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o "${BINARY_PATH}" "${INSTALL_DIR}/free-gateway.go"
chmod 0755 "${BINARY_PATH}"

config_file="${CONFIG_DIR}/free-gateway.env"
if [[ ! -f "${config_file}" ]]; then
  cp "${CONFIG_DIR}/free-gateway.env.example" "${config_file}"
  chmod 0600 "${config_file}"
  echo
  echo "Configuration template created: ${config_file}"
  echo "Set Redis, LISTEN_ADDR, BACKEND_URL, and BACKEND_PATH before starting the service."
  echo "Then run: systemctl enable --now free-gateway"
else
  echo "Keeping existing configuration: ${config_file}"
  systemctl daemon-reload
  systemctl restart free-gateway
  echo "Updated and restarted free-gateway."
fi

systemctl daemon-reload
echo
echo "Status: systemctl status free-gateway --no-pager"
echo "Logs:   journalctl -u free-gateway -f"
