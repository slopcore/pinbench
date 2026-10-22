/**
 * A one-lease DHCP server for the emulated guest network (RFC 2131 subset).
 *
 * Firmware on a hardwired-TCP/IP part asks for an address with a UDP
 * broadcast from port 68 to port 67, which no real host would see. The W5500
 * model hands such a datagram to {@link dhcpReply}, and loops the answer back
 * into the socket as if it came from the gateway. The same {@link GUEST_NET}
 * lease every time.
 */

import { GUEST_NET } from './net'

const MAGIC = [0x63, 0x82, 0x53, 0x63]
const OPT_MSG_TYPE = 53
const OPT_SERVER_ID = 54
const OPT_LEASE = 51
const OPT_SUBNET = 1
const OPT_ROUTER = 3
const OPT_DNS = 6
const OPT_END = 255

const DISCOVER = 1
const OFFER = 2
const REQUEST = 3
const ACK = 5
const RELEASE = 7

const LEASE_SECONDS = 86400

/** The DHCP message type (option 53) of a BOOTREQUEST/BOOTREPLY, or null if it is not DHCP. */
export function dhcpMessageType(packet: Uint8Array): number | null {
  if (packet.length < 240 || (packet[0] !== 1 && packet[0] !== 2)) return null
  for (let i = 0; i < 4; i++) if (packet[236 + i] !== MAGIC[i]) return null
  let at = 240
  while (at < packet.length) {
    const code = packet[at]!
    if (code === OPT_END) break
    if (code === 0) {
      at++
      continue
    }
    const len = packet[at + 1] ?? 0
    if (code === OPT_MSG_TYPE && len >= 1) return packet[at + 2] ?? null
    at += 2 + len
  }
  return null
}

/**
 * The server's reply to one client datagram: OFFER for DISCOVER, ACK for
 * REQUEST, nothing for RELEASE/INFORM/garbage.
 */
export function dhcpReply(request: Uint8Array): Uint8Array | null {
  const type = dhcpMessageType(request)
  if (type === RELEASE || (type !== DISCOVER && type !== REQUEST)) return null
  const out = new Uint8Array(300)
  out[0] = 2 // BOOTREPLY
  out[1] = 1 // Ethernet
  out[2] = 6 // hlen
  out.set(request.subarray(4, 8), 4) // xid
  out.set(request.subarray(10, 12), 10) // flags (broadcast bit)
  out.set(GUEST_NET.guest, 16) // yiaddr
  out.set(GUEST_NET.gateway, 20) // siaddr
  out.set(request.subarray(28, 44), 28) // chaddr
  out.set(MAGIC, 236)
  const options = [
    OPT_MSG_TYPE,
    1,
    type === DISCOVER ? OFFER : ACK,
    OPT_SERVER_ID,
    4,
    ...GUEST_NET.gateway,
    OPT_LEASE,
    4,
    (LEASE_SECONDS >>> 24) & 0xff,
    (LEASE_SECONDS >>> 16) & 0xff,
    (LEASE_SECONDS >>> 8) & 0xff,
    LEASE_SECONDS & 0xff,
    OPT_SUBNET,
    4,
    ...GUEST_NET.netmask,
    OPT_ROUTER,
    4,
    ...GUEST_NET.gateway,
    OPT_DNS,
    4,
    ...GUEST_NET.dns,
    OPT_END
  ]
  out.set(options, 240)
  return out
}
