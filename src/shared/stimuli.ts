/**
 * Per-device-model stimulus sets for the Inspector IN panel.
 *
 * The design gives every part stimuli — resets/boot straps for the MCU, card
 * insert/remove for the SD socket, NMEA scenarios for the GNSS, RTC/IMU/mag
 * events for the sensor cluster, battery/charger/buzzer for power, console
 * replay for the USB bridge. This table drives a generic panel that sends each
 * as an `onCommand(command, args)`; a model consumes what it understands and
 * quarantines the rest under its defined failure policy.
 *
 * The LR1110 keeps its own hand-built panel (rich RSSI/SNR fields); the
 * keyboard coprocessor gets a dedicated matrix component. Everything else
 * renders from here.
 */

export interface StimulusButton {
  label: string
  /** Sent as `onCommand(command, args)`. */
  command: string
  args?: Record<string, unknown>
}

export interface StimulusGroup {
  /** Section caption inside the IN panel. */
  title: string
  buttons: StimulusButton[]
}

/** Keyed by `PartDefinition.deviceModel`. Absent → no generic panel. */
export const STIMULI: Record<string, StimulusGroup[]> = {
  'esp32s3.soc': [
    {
      title: 'Reset & boot',
      buttons: [
        { label: 'Power-on reset', command: 'reset', args: { cause: 'poweron' } },
        { label: 'Brownout reset', command: 'reset', args: { cause: 'brownout' } },
        { label: 'Watchdog reset', command: 'reset', args: { cause: 'wdt' } },
        { label: 'Deep-sleep wake', command: 'wake', args: { source: 'timer' } }
      ]
    },
    {
      title: 'Boot straps',
      buttons: [
        { label: 'Normal boot (GPIO0 high)', command: 'strap', args: { gpio0: 1 } },
        { label: 'Download mode (GPIO0 low)', command: 'strap', args: { gpio0: 0 } }
      ]
    }
  ],
  'esp32c6.soc': [
    {
      title: 'Reset & boot',
      buttons: [
        { label: 'Power-on reset', command: 'reset', args: { cause: 'poweron' } },
        { label: 'Brownout reset', command: 'reset', args: { cause: 'brownout' } },
        { label: 'Watchdog reset', command: 'reset', args: { cause: 'wdt' } },
        { label: 'Deep-sleep wake', command: 'wake', args: { source: 'timer' } }
      ]
    },
    {
      title: 'Boot straps',
      buttons: [
        { label: 'Normal boot (GPIO9 high)', command: 'strap', args: { gpio9: 1 } },
        { label: 'Download mode (GPIO9 low)', command: 'strap', args: { gpio9: 0 } }
      ]
    }
  ],
  'hynitron.cst816s': [
    {
      title: 'Touch (or click the panel)',
      buttons: [
        { label: 'Tap centre', command: 'tap', args: { x: 120, y: 120 } },
        { label: 'Tap top', command: 'tap', args: { x: 120, y: 40 } },
        { label: 'Tap bottom', command: 'tap', args: { x: 120, y: 200 } },
        { label: 'Lift finger', command: 'release' }
      ]
    },
    {
      title: 'Gestures',
      buttons: [
        { label: 'Swipe up', command: 'gesture', args: { name: 'swipe-up' } },
        { label: 'Swipe down', command: 'gesture', args: { name: 'swipe-down' } },
        { label: 'Swipe left', command: 'gesture', args: { name: 'swipe-left' } },
        { label: 'Swipe right', command: 'gesture', args: { name: 'swipe-right' } },
        { label: 'Long press', command: 'gesture', args: { name: 'long-press' } }
      ]
    }
  ],
  'wiznet.w5500': [
    {
      title: 'Ethernet cable',
      buttons: [
        { label: 'Plug in', command: 'cable', args: { plugged: true } },
        { label: 'Unplug', command: 'cable', args: { plugged: false } }
      ]
    }
  ],
  'generic.sdcard': [
    {
      title: 'Card',
      buttons: [
        { label: 'Insert card', command: 'card', args: { present: true } },
        { label: 'Remove card', command: 'card', args: { present: false } },
        { label: 'Write-protect on', command: 'writeProtect', args: { on: true } },
        { label: 'Write-protect off', command: 'writeProtect', args: { on: false } },
        { label: 'CRC error on next read', command: 'fault', args: { kind: 'crc' } }
      ]
    }
  ],
  'zhongke.atgm336h': [
    {
      title: 'NMEA scenario',
      buttons: [
        { label: '3D fix (stationary)', command: 'scenario', args: { name: 'fix-3d' } },
        { label: 'No fix / acquiring', command: 'scenario', args: { name: 'no-fix' } },
        { label: 'Moving (5 m/s track)', command: 'scenario', args: { name: 'moving' } },
        { label: 'Lost fix', command: 'scenario', args: { name: 'lost-fix' } }
      ]
    }
  ],
  'pinbench.i2c-cluster': [
    {
      title: 'RTC',
      buttons: [
        { label: 'Tick 1 s', command: 'rtc', args: { advanceSeconds: 1 } },
        { label: 'Alarm fires', command: 'rtc', args: { alarm: true } }
      ]
    },
    {
      title: 'IMU',
      buttons: [
        { label: 'Tap', command: 'imu', args: { event: 'tap' } },
        { label: 'Free-fall', command: 'imu', args: { event: 'freefall' } },
        { label: 'Orientation: face-up', command: 'imu', args: { orientation: 'face-up' } }
      ]
    },
    {
      title: 'Magnetometer',
      buttons: [
        { label: 'Heading 0° (N)', command: 'mag', args: { headingDeg: 0 } },
        { label: 'Heading 90° (E)', command: 'mag', args: { headingDeg: 90 } },
        { label: 'Hard-iron disturbance', command: 'mag', args: { disturbed: true } }
      ]
    }
  ],
  'pinbench.power': [
    {
      title: 'Battery',
      buttons: [
        { label: 'Full (4.2 V)', command: 'battery', args: { millivolts: 4200 } },
        { label: 'Nominal (3.7 V)', command: 'battery', args: { millivolts: 3700 } },
        { label: 'Low (3.3 V)', command: 'battery', args: { millivolts: 3300 } },
        { label: 'Critical (3.0 V)', command: 'battery', args: { millivolts: 3000 } }
      ]
    },
    {
      title: 'Charger',
      buttons: [
        { label: 'Plug in USB power', command: 'charger', args: { state: 'charging' } },
        { label: 'Charge complete', command: 'charger', args: { state: 'done' } },
        { label: 'Unplug', command: 'charger', args: { state: 'discharging' } }
      ]
    },
    {
      title: 'Buzzer',
      buttons: [{ label: 'Confirm buzz', command: 'buzzer', args: { pattern: 'confirm' } }]
    }
  ],
  'wch.ch340k': [
    {
      title: 'Console replay',
      buttons: [
        { label: 'Send "reboot\\n"', command: 'replay', args: { text: 'reboot\n' } },
        { label: 'Send Ctrl-C', command: 'replay', args: { bytes: [3] } },
        { label: 'Toggle DTR (reset pulse)', command: 'line', args: { dtr: true } }
      ]
    }
  ],
  'pinbench.button': [
    {
      title: 'Button',
      buttons: [
        { label: 'Press', command: 'press', args: { down: true } },
        { label: 'Release', command: 'press', args: { down: false } },
        { label: 'Click (200 ms)', command: 'press', args: { holdMs: 200 } },
        { label: 'Long press (1.2 s)', command: 'press', args: { holdMs: 1200 } },
        { label: 'Long press (2 s)', command: 'press', args: { holdMs: 2000 } }
      ]
    }
  ]
}

export function stimuliFor(deviceModel: string | undefined): StimulusGroup[] {
  return deviceModel ? (STIMULI[deviceModel] ?? []) : []
}
