# /// script
# requires-python = ">=3.11"
# dependencies = ["bleak>=0.22"]
# ///
"""Talk to an Omi CV1 pendant over Bluetooth from a Mac (or any machine bleak supports).

    uv run scripts/pendant/omi_pendant.py scan
    uv run scripts/pendant/omi_pendant.py status
    uv run scripts/pendant/omi_pendant.py clear --yes [--address <id from scan>]

The pendant accepts ONE connection. Force-quit the Omi app on the phone first (and disconnect "Omi"
in iOS Settings > Bluetooth if listed) or the pendant won't advertise. macOS asks once for
Bluetooth permission for the terminal running this.

`clear` erases the pendant's stored audio ring (everything recorded while no phone was streaming).
It breaks the Omi app's phantom "legacy SD" sync loop described in the outage report. Protocol,
verified against firmware 3.0.21 (omi/firmware/omi/src/lib/core/storage.c):
- write characteristic 30295781-…: 0x03 STOP_SYNC, 0x13 RING_CLEAR (single byte each)
- the reply is a notification on the same characteristic: [0x01 ACK, status], status 0 = success
  (6 invalid command, 9 storage not ready, 10 sequence out of range)
- read characteristic 30295782-…: 4 x uint32 LE = used_bytes, unread_packets, free_bytes, rtc_valid
"""

from __future__ import annotations

import argparse
import asyncio
import struct
import sys

from bleak import BleakClient, BleakScanner

AUDIO_SERVICE = "19b10000-e8f2-537e-4f6c-d104768a1214"
STORAGE_CMD = "30295781-4301-eabd-2904-2849adfeae43"
STORAGE_STATUS = "30295782-4301-eabd-2904-2849adfeae43"
FW_REV = "00002a26-0000-1000-8000-00805f9b34fb"
BATTERY = "00002a19-0000-1000-8000-00805f9b34fb"
STATUS_NAMES = {0: "ok", 6: "invalid command", 9: "storage not ready", 10: "sequence out of range"}


async def find(timeout: float):
    """Pendants advertising Omi's audio service (a name alone isn't enough), strongest first."""
    devices = await BleakScanner.discover(timeout=timeout, return_adv=True)
    hits = [(d, adv) for d, adv in devices.values() if AUDIO_SERVICE in [u.lower() for u in adv.service_uuids]]
    return sorted(hits, key=lambda h: h[1].rssi, reverse=True)


async def read_status(client: BleakClient) -> dict:
    raw = bytes(await client.read_gatt_char(STORAGE_STATUS))
    if len(raw) != 16:
        raise RuntimeError(f"storage status is {len(raw)} bytes, expected 16 (raw {raw.hex()}); protocol changed?")
    used, unread, free, rtc = struct.unpack("<4I", raw)
    return {"used_bytes": used, "unread_packets": unread, "free_bytes": free, "rtc": rtc, "raw": raw.hex()}


async def command(client: BleakClient, acks: asyncio.Queue, op: int, wait: float) -> tuple[int, bytes]:
    """Sends one storage command and returns (status, raw ack), all within [wait] seconds."""
    while not acks.empty():  # a stale reply must not answer this command
        acks.get_nowait()
    loop = asyncio.get_running_loop()
    deadline = loop.time() + wait
    await asyncio.wait_for(client.write_gatt_char(STORAGE_CMD, bytes([op]), response=True), timeout=wait)
    while True:
        data = await asyncio.wait_for(acks.get(), timeout=max(0.05, deadline - loop.time()))
        if len(data) == 2 and data[0] == 0x01:
            return data[1], data
        print(f"  (ignored notification {data[:16].hex()}{'...' if len(data) > 16 else ''})")


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("action", choices=["scan", "status", "clear"])
    ap.add_argument("--yes", action="store_true", help="required for clear: erases stored audio")
    ap.add_argument("--timeout", type=float, default=15.0, help="scan seconds")
    ap.add_argument("--address", help="device id from `scan`; required for clear when several pendants are seen")
    a = ap.parse_args()

    hits = await find(a.timeout)
    if a.action == "scan" or not hits:
        for d, adv in hits:
            print(f"{d.name or '?'}  {d.address}  rssi {adv.rssi}")
        if not hits:
            print("No Omi advertising. Is the phone app closed and the pendant on?", file=sys.stderr)
            return 1 if a.action != "scan" else 0
        return 0
    if a.action == "clear" and not a.yes:
        print("clear erases the pendant's stored audio; rerun with --yes", file=sys.stderr)
        return 2
    if a.address:
        hits = [h for h in hits if h[0].address.lower() == a.address.lower()]
        if not hits:
            print(f"{a.address} is not advertising", file=sys.stderr)
            return 1
    elif a.action == "clear" and len(hits) > 1:
        print("Several pendants are advertising; pick one with --address (see `scan`)", file=sys.stderr)
        return 2

    device = hits[0][0]
    async with BleakClient(device) as client:
        fw = bytes(await client.read_gatt_char(FW_REV)).decode(errors="replace")
        battery = bytes(await client.read_gatt_char(BATTERY))[0]
        before = await read_status(client)
        print(f"{device.name} {device.address}  firmware {fw}  battery {battery}%")
        print(f"stored: {before['used_bytes']:,} bytes, {before['unread_packets']:,} unread packets; "
              f"free {before['free_bytes']:,}; clock valid flag {before['rtc']}  (raw {before['raw']})")
        if a.action == "status":
            return 0
        acks: asyncio.Queue = asyncio.Queue()
        await client.start_notify(STORAGE_CMD, lambda _, data: acks.put_nowait(bytes(data)))
        try:
            for op, name, wait in ((0x03, "stop sync", 3.0), (0x13, "clear", 20.0)):
                status, raw = await command(client, acks, op, wait)
                print(f"{name} ({op:#04x}): ack {raw.hex()} = status {status} ({STATUS_NAMES.get(status, 'unknown')})")
                if status != 0:
                    return 3
            await asyncio.sleep(2)
            after = await read_status(client)
            print(f"after: {after['used_bytes']:,} bytes, {after['unread_packets']:,} unread packets  (raw {after['raw']})")
            if after["used_bytes"] or after["unread_packets"]:
                print("Not empty after clear; check again before trusting it.", file=sys.stderr)
                return 4
        finally:
            await client.stop_notify(STORAGE_CMD)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
