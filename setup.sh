#!/bin/bash
echo -e "\e[1;32m[+] Setting up Sinket VPS environment in CodeSandbox...\e[0m"

# Install core dependencies quietly
sudo apt-get update -y > /dev/null 2>&1
sudo apt-get install curl wget git python3 htop -y > /dev/null 2>&1

# Install Cloudflared natively
if ! command -v cloudflared &> /dev/null; then
    echo "[+] Installing Cloudflare Tunnel..."
    curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb > /dev/null 2>&1
    sudo dpkg -i cloudflared.deb > /dev/null 2>&1
    rm cloudflared.deb
fi

# Install SSHX globally
if ! command -v sshx &> /dev/null; then
    echo "[+] Installing SSHX..."
    curl -sSf https://sshx.io/get | sh > /dev/null 2>&1
fi

echo -e "\e[1;32m[+] Sinket Core Tools Installed! Booting Backend...\e[0m"
