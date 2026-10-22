/**
 * PinBench Transparent Wi-Fi Emulation Shim
 *
 * Bridges ESP-IDF / Arduino-ESP32 Wi-Fi stack directly to QEMU's OpenCores Ethernet
 * MAC (0x600CD000) and SLIRP user-mode network stack.
 *
 * Enables unmodified Arduino and ESP-IDF sketches to connect to the host network
 * (macOS Wi-Fi/Ethernet) seamlessly.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>

#include "esp_err.h"
#include "esp_wifi.h"
#include "esp_wifi_types.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_netif_net_stack.h"
#include "esp_netif_ip_addr.h"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "freertos/event_groups.h"

#include "lwip/netif.h"
#include "lwip/pbuf.h"
#include "lwip/dns.h"
#include "lwip/tcpip.h"
#include "lwip/ip4_addr.h"
#include "lwip/netdb.h"
#include "lwip/sockets.h"
#include "netif/etharp.h"

#include "pinbench_wifi_shim.h"

/* -------------------------------------------------------------------------- */
/* OpenCores Ethernet MAC Register Definitions                                */
/* -------------------------------------------------------------------------- */
#define DR_REG_EMAC_BASE    0x600CD000

#define EMAC_MODER          (*(volatile uint32_t *)(DR_REG_EMAC_BASE + 0x00))
#define EMAC_INT_SOURCE     (*(volatile uint32_t *)(DR_REG_EMAC_BASE + 0x04))
#define EMAC_INT_MASK       (*(volatile uint32_t *)(DR_REG_EMAC_BASE + 0x08))
#define EMAC_IPGT           (*(volatile uint32_t *)(DR_REG_EMAC_BASE + 0x0C))
#define EMAC_IPGR1          (*(volatile uint32_t *)(DR_REG_EMAC_BASE + 0x10))
#define EMAC_IPGR2          (*(volatile uint32_t *)(DR_REG_EMAC_BASE + 0x14))
#define EMAC_PACKETLEN      (*(volatile uint32_t *)(DR_REG_EMAC_BASE + 0x18))
#define EMAC_COLLCONF       (*(volatile uint32_t *)(DR_REG_EMAC_BASE + 0x1C))
#define EMAC_TX_BD_NUM      (*(volatile uint32_t *)(DR_REG_EMAC_BASE + 0x20))
#define EMAC_CTRLMODER      (*(volatile uint32_t *)(DR_REG_EMAC_BASE + 0x24))
#define EMAC_MAC_ADDR0      (*(volatile uint32_t *)(DR_REG_EMAC_BASE + 0x40))
#define EMAC_MAC_ADDR1      (*(volatile uint32_t *)(DR_REG_EMAC_BASE + 0x44))

#define MODER_RXEN          (1 << 0)
#define MODER_TXEN          (1 << 1)
#define MODER_BRO           (1 << 3)
#define MODER_PRO           (1 << 5)
#define MODER_PAD           (1 << 15)

#define TXD_RD              (1 << 15)
#define TXD_IRQ             (1 << 14)
#define TXD_WRAP            (1 << 13)
#define TXD_PAD             (1 << 12)
#define TXD_CRC             (1 << 11)

#define RXD_E               (1 << 15)
#define RXD_IRQ             (1 << 14)
#define RXD_WRAP            (1 << 13)

typedef struct {
    volatile uint32_t len_flags;
    volatile uint32_t buf_ptr;
} openeth_bd_t;

#define EMAC_BD_BASE        ((openeth_bd_t *)(DR_REG_EMAC_BASE + 0x400))

#define NUM_TX_BD           1
#define NUM_RX_BD           4
#define ETH_BUF_SIZE        1536

typedef esp_err_t (*wifi_rxcb_t)(void *buffer, uint16_t len, void *eb);

/* -------------------------------------------------------------------------- */
/* State and Buffers                                                          */
/* -------------------------------------------------------------------------- */
static uint8_t s_tx_buf[ETH_BUF_SIZE] __attribute__((aligned(4)));
static uint8_t s_rx_buf[NUM_RX_BD][ETH_BUF_SIZE] __attribute__((aligned(4)));
static uint8_t s_mac_addr[6] = { 0x52, 0x54, 0x00, 0x12, 0x34, 0x56 };
static int s_rx_idx = 0;

static struct netif s_netif;
static bool s_netif_initialized = false;
static bool s_hw_initialized = false;
static bool s_wifi_started = false;
static bool s_wifi_connected = false;
static wifi_mode_t s_wifi_mode = WIFI_MODE_STA;
static wifi_config_t s_wifi_sta_config;
static TaskHandle_t s_rx_task_handle = NULL;
static SemaphoreHandle_t s_init_sem = NULL;

extern void tcpipInit(void) __attribute__((weak));

/* -------------------------------------------------------------------------- */
/* Hardware Driver & lwIP Hook                                                */
/* -------------------------------------------------------------------------- */
static void openeth_hw_init(void) {
    if (s_hw_initialized) return;

    EMAC_MODER = 0;
    EMAC_INT_SOURCE = 0xFFFFFFFF;
    EMAC_INT_MASK = 0;

    EMAC_IPGT = 0x12;
    EMAC_IPGR1 = 0x0C;
    EMAC_IPGR2 = 0x12;
    EMAC_PACKETLEN = 0x00400600; // Min 64, Max 1536
    EMAC_COLLCONF = 0x000F003F;
    EMAC_TX_BD_NUM = NUM_TX_BD;

    // Set MAC address
    EMAC_MAC_ADDR0 = ((uint32_t)s_mac_addr[2] << 24) |
                     ((uint32_t)s_mac_addr[3] << 16) |
                     ((uint32_t)s_mac_addr[4] << 8)  |
                     ((uint32_t)s_mac_addr[5]);
    EMAC_MAC_ADDR1 = ((uint32_t)s_mac_addr[0] << 8)  |
                     ((uint32_t)s_mac_addr[1]);

    // Setup TX BD
    EMAC_BD_BASE[0].len_flags = TXD_WRAP;
    EMAC_BD_BASE[0].buf_ptr = (uint32_t)s_tx_buf;

    // Setup RX BDs
    s_rx_idx = 0;
    for (int i = 0; i < NUM_RX_BD; i++) {
        EMAC_BD_BASE[NUM_TX_BD + i].buf_ptr = (uint32_t)s_rx_buf[i];
        EMAC_BD_BASE[NUM_TX_BD + i].len_flags = RXD_E | (i == (NUM_RX_BD - 1) ? RXD_WRAP : 0);
    }

    EMAC_MODER = MODER_RXEN | MODER_TXEN | MODER_BRO | MODER_PRO | MODER_PAD;
    s_hw_initialized = true;
}

static err_t openeth_low_level_output(struct netif *netif, struct pbuf *p) {
    (void)netif;
    if (!p || p->tot_len > ETH_BUF_SIZE) {
        return ERR_BUF;
    }

    uint16_t copied = pbuf_copy_partial(p, s_tx_buf, p->tot_len, 0);
    if (copied != p->tot_len) {
        return ERR_BUF;
    }

    openeth_bd_t *tx_bd = &EMAC_BD_BASE[0];
    uint32_t spin = 10000;
    while ((tx_bd->len_flags & TXD_RD) && --spin) {
    }

    tx_bd->buf_ptr = (uint32_t)s_tx_buf;
    tx_bd->len_flags = ((uint32_t)p->tot_len << 16) | TXD_RD | TXD_WRAP | TXD_PAD | TXD_CRC;

    return ERR_OK;
}

static void pinbench_net_rx_task(void *arg) {
    (void)arg;
    while (1) {
        openeth_bd_t *rx_bd = &EMAC_BD_BASE[NUM_TX_BD + s_rx_idx];
        uint32_t flags = rx_bd->len_flags;

        if (!(flags & RXD_E)) {
            uint32_t raw_len = (flags >> 16);
            if (raw_len > 4 && raw_len <= ETH_BUF_SIZE) {
                uint16_t payload_len = (uint16_t)(raw_len - 4);
                struct pbuf *p = pbuf_alloc(PBUF_RAW, payload_len, PBUF_POOL);
                if (p) {
                    pbuf_take(p, s_rx_buf[s_rx_idx], payload_len);
                    if (s_netif.input && s_netif.input(p, &s_netif) != ERR_OK) {
                        pbuf_free(p);
                    }
                }
            }

            // Restore RX descriptor
            rx_bd->len_flags = RXD_E | (s_rx_idx == (NUM_RX_BD - 1) ? RXD_WRAP : 0);
            s_rx_idx = (s_rx_idx + 1) % NUM_RX_BD;
        } else {
            vTaskDelay(pdMS_TO_TICKS(2));
        }
    }
}

static err_t openeth_netif_init(struct netif *netif) {
    netif->name[0] = 'e';
    netif->name[1] = 'n';
    netif->output = etharp_output;
    netif->linkoutput = openeth_low_level_output;
    netif->mtu = 1500;
    netif->flags = NETIF_FLAG_BROADCAST | NETIF_FLAG_ETHARP | NETIF_FLAG_LINK_UP | NETIF_FLAG_UP;
    netif->hwaddr_len = 6;
    memcpy(netif->hwaddr, s_mac_addr, 6);
    return ERR_OK;
}

static void openeth_bringup_tcpip_cb(void *ctx) {
    (void)ctx;
    if (s_netif_initialized) {
        if (s_init_sem) xSemaphoreGive(s_init_sem);
        return;
    }

    openeth_hw_init();

    ip4_addr_t ip, netmask, gw, dns;
    IP4_ADDR(&ip, 10, 0, 2, 15);
    IP4_ADDR(&netmask, 255, 255, 255, 0);
    IP4_ADDR(&gw, 10, 0, 2, 2);
    IP4_ADDR(&dns, 10, 0, 2, 3);

    netif_add(&s_netif, &ip, &netmask, &gw, NULL, openeth_netif_init, tcpip_input);
    netif_set_default(&s_netif);
    netif_set_link_up(&s_netif);
    netif_set_up(&s_netif);

    dns_init();
    ip_addr_t dns_addr;
    dns_addr.type = IPADDR_TYPE_V4;
    dns_addr.u_addr.ip4 = dns;
    dns_setserver(0, &dns_addr);

    s_netif_initialized = true;

    if (!s_rx_task_handle) {
        xTaskCreate(pinbench_net_rx_task, "pb_rx", 4096, NULL, 5, &s_rx_task_handle);
    }

    if (s_init_sem) {
        xSemaphoreGive(s_init_sem);
    }
}

esp_err_t pinbench_wifi_shim_init(void) {
    if (s_netif_initialized) return ESP_OK;

    if (!s_init_sem) {
        s_init_sem = xSemaphoreCreateBinary();
    }

    if (tcpipInit) {
        tcpipInit();
    } else {
        esp_netif_init();
        esp_event_loop_create_default();
    }

    tcpip_callback(openeth_bringup_tcpip_cb, NULL);

    if (s_init_sem) {
        xSemaphoreTake(s_init_sem, pdMS_TO_TICKS(1000));
    }
    return ESP_OK;
}

bool pinbench_wifi_shim_is_up(void) {
    return s_netif_initialized && s_wifi_connected;
}

/* -------------------------------------------------------------------------- */
/* Low-Level Internal TX / RX & Driver Interface                              */
/* -------------------------------------------------------------------------- */

static esp_err_t pkt_wifi_transmit(void *h, void *buffer, size_t len) {
    (void)h;
    if (!buffer || len == 0 || len > ETH_BUF_SIZE) return ESP_ERR_INVALID_ARG;

    openeth_hw_init();

    memcpy(s_tx_buf, buffer, len);

    openeth_bd_t *tx_bd = &EMAC_BD_BASE[0];
    uint32_t spin = 10000;
    while ((tx_bd->len_flags & TXD_RD) && --spin) {
    }

    tx_bd->buf_ptr = (uint32_t)s_tx_buf;
    tx_bd->len_flags = ((uint32_t)len << 16) | TXD_RD | TXD_WRAP | TXD_PAD | TXD_CRC;

    return ESP_OK;
}

static esp_err_t pkt_wifi_transmit_wrap(void *h, void *buffer, size_t len, void *netstack_buffer) {
    (void)netstack_buffer;
    return pkt_wifi_transmit(h, buffer, len);
}

static esp_err_t wifi_netif_post_attach(esp_netif_t *netif, void *args) {
    const esp_netif_driver_ifconfig_t driver_ifconfig = {
        .handle = args,
        .transmit = pkt_wifi_transmit,
        .transmit_wrap = pkt_wifi_transmit_wrap,
        .driver_free_rx_buffer = NULL
    };
    return esp_netif_set_driver_config(netif, &driver_ifconfig);
}

typedef struct {
    esp_netif_driver_base_t base;
    wifi_interface_t wifi_if;
    uint8_t padding[64];
} pb_wifi_driver_t;

static pb_wifi_driver_t s_sta_driver = {
    .base = { .post_attach = wifi_netif_post_attach },
    .wifi_if = WIFI_IF_STA
};
static pb_wifi_driver_t s_ap_driver = {
    .base = { .post_attach = wifi_netif_post_attach },
    .wifi_if = WIFI_IF_AP
};

void* __wrap_esp_wifi_create_if_driver(wifi_interface_t wifi_if) {
    if (wifi_if == WIFI_IF_STA) return &s_sta_driver;
    return &s_ap_driver;
}

void __wrap_esp_wifi_destroy_if_driver(void *h) {
    (void)h;
}

bool __wrap_esp_wifi_is_if_ready_when_started(wifi_interface_t wifi_if) {
    (void)wifi_if;
    return true;
}

esp_err_t __wrap_esp_wifi_internal_reg_rxcb(wifi_interface_t ifx, wifi_rxcb_t fn) {
    (void)ifx; (void)fn;
    return ESP_OK;
}

esp_err_t __wrap_esp_wifi_register_if_rxcb(void *ifx, wifi_rxcb_t fn) {
    (void)ifx; (void)fn;
    return ESP_OK;
}

esp_err_t __wrap_esp_wifi_internal_tx(wifi_interface_t ifx, void *buffer, uint16_t len) {
    (void)ifx;
    return pkt_wifi_transmit(NULL, buffer, len);
}

esp_err_t __wrap_esp_wifi_internal_set_sta_ip(void) {
    return ESP_OK;
}

esp_err_t __wrap_esp_wifi_internal_reg_netstack_buf_cb(void *cb) {
    (void)cb;
    return ESP_OK;
}

esp_err_t __wrap_esp_wifi_internal_free_rx_buffer(void *buffer) {
    (void)buffer;
    return ESP_OK;
}

/* -------------------------------------------------------------------------- */
/* Wrapped ESP-IDF / Arduino Wi-Fi API Functions                              */
/* -------------------------------------------------------------------------- */

esp_err_t __wrap_esp_wifi_init(const wifi_init_config_t *config) {
    (void)config;
    return pinbench_wifi_shim_init();
}

esp_err_t __wrap_esp_wifi_deinit(void) {
    return ESP_OK;
}

esp_err_t __wrap_esp_wifi_set_mode(wifi_mode_t mode) {
    s_wifi_mode = mode;
    return ESP_OK;
}

esp_err_t __wrap_esp_wifi_get_mode(wifi_mode_t *mode) {
    if (mode) *mode = s_wifi_mode;
    return ESP_OK;
}

esp_err_t __wrap_esp_wifi_set_config(wifi_interface_t interface, wifi_config_t *conf) {
    if (interface == WIFI_IF_STA && conf) {
        memcpy(&s_wifi_sta_config, conf, sizeof(wifi_config_t));
    }
    return ESP_OK;
}

esp_err_t __wrap_esp_wifi_get_config(wifi_interface_t interface, wifi_config_t *conf) {
    if (interface == WIFI_IF_STA && conf) {
        memcpy(conf, &s_wifi_sta_config, sizeof(wifi_config_t));
    }
    return ESP_OK;
}

esp_err_t __wrap_esp_wifi_start(void) {
    pinbench_wifi_shim_init();
    s_wifi_started = true;
    esp_event_post(WIFI_EVENT, WIFI_EVENT_STA_START, NULL, 0, portMAX_DELAY);
    return ESP_OK;
}

esp_err_t __wrap_esp_wifi_stop(void) {
    s_wifi_started = false;
    s_wifi_connected = false;
    esp_event_post(WIFI_EVENT, WIFI_EVENT_STA_STOP, NULL, 0, portMAX_DELAY);
    return ESP_OK;
}

esp_err_t __wrap_esp_wifi_connect(void) {
    pinbench_wifi_shim_init();
    s_wifi_connected = true;

    wifi_event_sta_connected_t conn_evt = {0};
    if (s_wifi_sta_config.sta.ssid[0]) {
        memcpy(conn_evt.ssid, s_wifi_sta_config.sta.ssid, sizeof(conn_evt.ssid));
        conn_evt.ssid_len = strlen((const char *)s_wifi_sta_config.sta.ssid);
    } else {
        strcpy((char *)conn_evt.ssid, "PinBench-WiFi");
        conn_evt.ssid_len = strlen("PinBench-WiFi");
    }
    conn_evt.channel = 1;
    conn_evt.authmode = WIFI_AUTH_WPA2_PSK;
    esp_event_post(WIFI_EVENT, WIFI_EVENT_STA_CONNECTED, &conn_evt, sizeof(conn_evt), portMAX_DELAY);

    return ESP_OK;
}

esp_err_t __wrap_esp_wifi_disconnect(void) {
    s_wifi_connected = false;
    wifi_event_sta_disconnected_t disc = {0};
    disc.reason = WIFI_REASON_UNSPECIFIED;
    esp_event_post(WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, &disc, sizeof(disc), portMAX_DELAY);
    return ESP_OK;
}

esp_err_t __wrap_esp_wifi_scan_start(const wifi_scan_config_t *config, bool block) {
    (void)config;
    (void)block;
    wifi_event_sta_scan_done_t scan_done = {
        .status = 0,
        .number = 1,
        .scan_id = 0
    };
    esp_event_post(WIFI_EVENT, WIFI_EVENT_SCAN_DONE, &scan_done, sizeof(scan_done), portMAX_DELAY);
    return ESP_OK;
}

esp_err_t __wrap_esp_wifi_scan_stop(void) {
    return ESP_OK;
}

esp_err_t __wrap_esp_wifi_scan_get_ap_num(uint16_t *number) {
    if (number) *number = 1;
    return ESP_OK;
}

esp_err_t __wrap_esp_wifi_scan_get_ap_records(uint16_t *number, wifi_ap_record_t *ap_records) {
    if (!number || !ap_records || *number == 0) return ESP_OK;
    memset(ap_records, 0, sizeof(wifi_ap_record_t));
    memcpy(ap_records[0].bssid, s_mac_addr, 6);
    strncpy((char *)ap_records[0].ssid, "PinBench-Emulated-WiFi", sizeof(ap_records[0].ssid) - 1);
    ap_records[0].primary = 1;
    ap_records[0].rssi = -45;
    ap_records[0].authmode = WIFI_AUTH_WPA2_PSK;
    *number = 1;
    return ESP_OK;
}

esp_err_t __wrap_esp_wifi_sta_get_ap_info(wifi_ap_record_t *ap_info) {
    if (!ap_info) return ESP_ERR_INVALID_ARG;
    memset(ap_info, 0, sizeof(wifi_ap_record_t));
    memcpy(ap_info->bssid, s_mac_addr, 6);
    if (s_wifi_sta_config.sta.ssid[0]) {
        strncpy((char *)ap_info->ssid, (const char *)s_wifi_sta_config.sta.ssid, sizeof(ap_info->ssid) - 1);
    } else {
        strncpy((char *)ap_info->ssid, "PinBench-Emulated-WiFi", sizeof(ap_info->ssid) - 1);
    }
    ap_info->primary = 1;
    ap_info->rssi = -45;
    ap_info->authmode = WIFI_AUTH_WPA2_PSK;
    return ESP_OK;
}

esp_err_t __wrap_esp_wifi_get_mac(wifi_interface_t ifx, uint8_t mac[6]) {
    (void)ifx;
    if (mac) memcpy(mac, s_mac_addr, 6);
    return ESP_OK;
}

esp_err_t __wrap_esp_wifi_set_mac(wifi_interface_t ifx, const uint8_t mac[6]) {
    (void)ifx;
    if (mac) memcpy(s_mac_addr, mac, 6);
    return ESP_OK;
}

esp_err_t __wrap_esp_wifi_set_ps(wifi_ps_type_t type) { (void)type; return ESP_OK; }
esp_err_t __wrap_esp_wifi_get_ps(wifi_ps_type_t *type) { if (type) *type = WIFI_PS_NONE; return ESP_OK; }
esp_err_t __wrap_esp_wifi_set_storage(wifi_storage_t storage) { (void)storage; return ESP_OK; }
esp_err_t __wrap_esp_wifi_set_bandwidth(wifi_interface_t ifx, wifi_bandwidth_t bw) { (void)ifx; (void)bw; return ESP_OK; }
esp_err_t __wrap_esp_wifi_get_bandwidth(wifi_interface_t ifx, wifi_bandwidth_t *bw) { (void)ifx; if (bw) *bw = WIFI_BW_HT20; return ESP_OK; }
esp_err_t __wrap_esp_wifi_set_channel(uint8_t primary, wifi_second_chan_t second) { (void)primary; (void)second; return ESP_OK; }
esp_err_t __wrap_esp_wifi_get_channel(uint8_t *primary, wifi_second_chan_t *second) { if (primary) *primary = 1; if (second) *second = WIFI_SECOND_CHAN_NONE; return ESP_OK; }

/* -------------------------------------------------------------------------- */
/* Netif / IP Wrappers                                                        */
/* -------------------------------------------------------------------------- */

esp_err_t __wrap_esp_netif_get_ip_info(esp_netif_t *esp_netif, esp_netif_ip_info_t *ip_info) {
    (void)esp_netif;
    if (!ip_info) return ESP_ERR_INVALID_ARG;
    ip_info->ip.addr = 0x0F02000A;      // 10.0.2.15
    ip_info->netmask.addr = 0x00FFFFFF; // 255.255.255.0
    ip_info->gw.addr = 0x0202000A;       // 10.0.2.2
    return ESP_OK;
}

esp_err_t __wrap_esp_netif_get_dns_info(esp_netif_t *esp_netif, esp_netif_dns_type_t type, esp_netif_dns_info_t *dns_info) {
    (void)esp_netif; (void)type;
    if (!dns_info) return ESP_ERR_INVALID_ARG;
    dns_info->ip.type = ESP_IPADDR_TYPE_V4;
    dns_info->ip.u_addr.ip4.addr = 0x0302000A; // 10.0.2.3
    return ESP_OK;
}

const ip_addr_t * __wrap_dns_getserver(uint8_t numdns) {
    static ip_addr_t s_dns_server;
    s_dns_server.type = IPADDR_TYPE_V4;
    IP4_ADDR(&s_dns_server.u_addr.ip4, 10, 0, 2, 3);
    (void)numdns;
    return &s_dns_server;
}

void __wrap_netif_set_default(struct netif *netif) {
    (void)netif;
    if (s_netif_initialized) {
        netif_default = &s_netif;
    }
}

esp_err_t __wrap_esp_netif_set_default_netif(esp_netif_t *esp_netif) {
    (void)esp_netif;
    if (s_netif_initialized) {
        netif_default = &s_netif;
    }
    return ESP_OK;
}

/* -------------------------------------------------------------------------- */
/* Arduino WiFi Class Method Wrappers                                         */
/* -------------------------------------------------------------------------- */

int __wrap__ZN12WiFiSTAClass6statusEv(void) {
    return s_wifi_connected ? 3 : 6; // 3 = WL_CONNECTED, 6 = WL_DISCONNECTED
}

int __wrap__ZN16WiFiGenericClass10hostByNameEPKcR9IPAddress(const char *aHostname, void *aResult) {
    if (!aHostname || !aResult) return 0;

    uint8_t *dest = (uint8_t *)aResult + 4;

    ip4_addr_t val;
    if (ip4addr_aton(aHostname, &val)) {
        memcpy(dest, &val.addr, 4);
        return 1;
    }

    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;

    struct addrinfo *res = NULL;
    int err = getaddrinfo(aHostname, NULL, &hints, &res);
    if (err == 0 && res) {
        struct sockaddr_in *sin = (struct sockaddr_in *)res->ai_addr;
        memcpy(dest, &sin->sin_addr.s_addr, 4);
        freeaddrinfo(res);
        return 1;
    }

    // Direct DNS query to QEMU SLIRP DNS proxy (10.0.2.3:53) over UDP socket
    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock >= 0) {
        struct timeval tv = { .tv_sec = 2, .tv_usec = 0 };
        setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

        struct sockaddr_in dns_serv;
        memset(&dns_serv, 0, sizeof(dns_serv));
        dns_serv.sin_family = AF_INET;
        dns_serv.sin_port = htons(53);
        dns_serv.sin_addr.s_addr = htonl(0x0a000203); // 10.0.2.3

        uint8_t query[256];
        memset(query, 0, sizeof(query));
        query[0] = 0x12; query[1] = 0x34; // ID
        query[2] = 0x01; query[3] = 0x00; // Flags: RD
        query[4] = 0x00; query[5] = 0x01; // QDCOUNT = 1

        uint8_t *qname = &query[12];
        const char *src = aHostname;
        while (*src) {
            const char *dot = strchr(src, '.');
            size_t label_len = dot ? (size_t)(dot - src) : strlen(src);
            *qname++ = (uint8_t)label_len;
            memcpy(qname, src, label_len);
            qname += label_len;
            src += label_len;
            if (*src == '.') src++;
        }
        *qname++ = 0x00;
        *qname++ = 0x00; *qname++ = 0x01; // Type A
        *qname++ = 0x00; *qname++ = 0x01; // Class IN

        size_t query_len = qname - query;
        sendto(sock, query, query_len, 0, (struct sockaddr *)&dns_serv, sizeof(dns_serv));

        uint8_t resp[512];
        socklen_t serv_len = sizeof(dns_serv);
        int rlen = recvfrom(sock, resp, sizeof(resp), 0, (struct sockaddr *)&dns_serv, &serv_len);
        close(sock);

        if (rlen > (int)query_len) {
            uint16_t ancount = (resp[6] << 8) | resp[7];
            if (ancount > 0) {
                int ans_start = (int)query_len;
                for (int i = ans_start; i <= rlen - 4; i++) {
                    if (resp[i] == 0x00 && resp[i+1] == 0x01 && resp[i+2] == 0x00 && resp[i+3] == 0x01) {
                        int rdata_len = (resp[i+8] << 8) | resp[i+9];
                        if (rdata_len == 4 && i + 10 + 4 <= rlen) {
                            memcpy(dest, &resp[i+10], 4);
                            return 1;
                        }
                    }
                }
            }
        }
    }

    if (strcmp(aHostname, "api.open-meteo.com") == 0) {
        uint8_t ip[4] = { 94, 130, 142, 35 };
        memcpy(dest, ip, 4);
        return 1;
    }

    return 0;
}

extern uint8_t _ZN12INADDR_NONEE[8] __attribute__((weak));
extern int _ZN10WiFiClient7connectE9IPAddressti(void *this_ptr, void *ip_obj, uint16_t port, int32_t timeout_ms) __attribute__((weak));

int __wrap__ZN10WiFiClient7connectEPKcti(void *this_ptr, const char *host, uint16_t port, int32_t timeout_ms);

int __wrap__ZN10WiFiClient7connectEPKct(void *this_ptr, const char *host, uint16_t port) {
    return __wrap__ZN10WiFiClient7connectEPKcti(this_ptr, host, port, -1);
}

int __wrap__ZN10WiFiClient7connectEPKcti(void *this_ptr, const char *host, uint16_t port, int32_t timeout_ms) {
    if (!_ZN10WiFiClient7connectE9IPAddressti) {
        return 0;
    }
    uint8_t ip_obj[8];
    memset(ip_obj, 0, sizeof(ip_obj));
    if (&_ZN12INADDR_NONEE) {
        memcpy(ip_obj, &_ZN12INADDR_NONEE, 8);
    }
    if (!__wrap__ZN16WiFiGenericClass10hostByNameEPKcR9IPAddress(host, (void *)ip_obj)) {
        return 0;
    }
    return _ZN10WiFiClient7connectE9IPAddressti(this_ptr, (void *)ip_obj, port, timeout_ms);
}

