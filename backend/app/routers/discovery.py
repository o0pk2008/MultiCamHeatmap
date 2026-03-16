import ipaddress
import socket
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel


class ScanRequest(BaseModel):
    # 两种输入方式二选一：
    # 1. subnet: CIDR，如 "192.168.1.0/24"
    # 2. ip_range: IP 范围，如 "192.168.4.1-192.168.4.255"
    subnet: Optional[str] = None
    ip_range: Optional[str] = None
    port: int = 554  # 默认 RTSP 端口
    timeout_ms: int = 300


class DiscoveredDevice(BaseModel):
    ip: str
    port: int


class ScanResponse(BaseModel):
    devices: List[DiscoveredDevice]


router = APIRouter(prefix="/api/discovery", tags=["discovery"])


def _is_port_open(ip: str, port: int, timeout_ms: int) -> bool:
    """简单的 TCP 端口探测，用于发现可能的摄像头主机。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout_ms / 1000.0)
    try:
        s.connect((ip, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


@router.post("/scan", response_model=ScanResponse)
def scan_subnet(req: ScanRequest) -> ScanResponse:
    """
    按网段或 IP 范围扫描可能存在摄像头的 IP。
    只做简单的 TCP 端口探测（默认 554），不访问具体 RTSP 路径。
    """
    devices: List[DiscoveredDevice] = []

    # 优先使用 ip_range（更贴近用户输入习惯）
    if req.ip_range:
        try:
            start_str, end_str = [s.strip() for s in req.ip_range.split("-")]
            start_ip = ipaddress.ip_address(start_str)
            end_ip = ipaddress.ip_address(end_str)
            if int(end_ip) < int(start_ip):
                raise ValueError
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid ip_range format")

        current = start_ip
        while int(current) <= int(end_ip):
            ip_str = str(current)
            if _is_port_open(ip_str, req.port, req.timeout_ms):
                devices.append(DiscoveredDevice(ip=ip_str, port=req.port))
            current = ipaddress.ip_address(int(current) + 1)

        return ScanResponse(devices=devices)

    # 退而求其次：使用 CIDR 子网
    if req.subnet:
        try:
            net = ipaddress.ip_network(req.subnet, strict=False)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid subnet")

        for ip in net.hosts():
            ip_str = str(ip)
            if _is_port_open(ip_str, req.port, req.timeout_ms):
                devices.append(DiscoveredDevice(ip=ip_str, port=req.port))

        return ScanResponse(devices=devices)

    # 两个都没提供
    raise HTTPException(status_code=400, detail="Either subnet or ip_range must be provided")

    return ScanResponse(devices=devices)

