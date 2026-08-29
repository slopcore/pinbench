import { describe, expect, it } from 'vitest'
import {
  collectEnvNames,
  overrideConfigIni,
  parseEnvNamesFromIni,
  parseExtraConfigs,
  parseProjectConfig,
  usbBuildOverrideIni
} from './pio'

describe('parseProjectConfig', () => {
  it('lists environments and merges [env] defaults into each', () => {
    const json = [
      [
        'env',
        [
          ['framework', ['arduino']],
          ['monitor_speed', 115200]
        ]
      ],
      ['env:esp32s3', [['board', 'esp32-s3-devkitc-1']]],
      ['env:native', [['platform', 'native']]]
    ]
    const config = parseProjectConfig(json)
    expect(config.envs).toEqual(['esp32s3', 'native'])
    expect(config.options['esp32s3']).toMatchObject({
      board: 'esp32-s3-devkitc-1',
      framework: 'arduino',
      monitor_speed: '115200'
    })
    expect(config.options['native']!.framework).toBe('arduino')
  })

  it('rejects output that is not the expected array', () => {
    expect(() => parseProjectConfig({ nope: true })).toThrow(/not an array/)
  })
})

describe('parseEnvNamesFromIni', () => {
  it('reads env section names without needing pio', () => {
    const ini = '[platformio]\ndefault_envs = a\n\n[env:a]\nboard = x\n[env:b-2]\nboard = y\n'
    expect(parseEnvNamesFromIni(ini)).toEqual(['a', 'b-2'])
  })
})

describe('parseExtraConfigs', () => {
  it('reads an indented continuation list', () => {
    const ini = [
      '[platformio]',
      'default_envs = native',
      'extra_configs =',
      '  variants/*/platformio.ini',
      '  platformio.local.ini   ; developer overrides',
      '',
      '[env:native]',
      'platform = native'
    ].join('\n')
    expect(parseExtraConfigs(ini)).toEqual(['variants/*/platformio.ini', 'platformio.local.ini'])
  })

  it('reads a single inline value and a comma list', () => {
    expect(parseExtraConfigs('[platformio]\nextra_configs = a.ini\n')).toEqual(['a.ini'])
    expect(parseExtraConfigs('[platformio]\nextra_configs = a.ini, b.ini\n')).toEqual([
      'a.ini',
      'b.ini'
    ])
  })

  it('is empty when there is no extra_configs', () => {
    expect(parseExtraConfigs('[platformio]\ndefault_envs = a\n[env:a]\nboard = x\n')).toEqual([])
  })
})

describe('collectEnvNames', () => {
  it('follows extra_configs globs and unions every env, in discovery order', () => {
    const files: Record<string, string> = {
      'platformio.ini': [
        '[platformio]',
        'extra_configs =',
        '  variants/*/platformio.ini',
        '[env:native]',
        'platform = native'
      ].join('\n'),
      'variants/heltec_wireless_paper/platformio.ini':
        '[env:Heltec_Wireless_Paper_repeater]\nboard = esp32-s3-devkitc-1\n' +
        '[env:Heltec_Wireless_Paper_room_server]\nboard = esp32-s3-devkitc-1\n',
      'variants/rak4631/platformio.ini': '[env:RAK4631_repeater]\nboard = nrf52840\n'
    }
    const envs = collectEnvNames(
      (rel) => files[rel] ?? null,
      (pattern) => {
        expect(pattern).toBe('variants/*/platformio.ini')
        return ['variants/rak4631/platformio.ini', 'variants/heltec_wireless_paper/platformio.ini']
      }
    )
    expect(envs).toEqual([
      'native',
      'Heltec_Wireless_Paper_repeater',
      'Heltec_Wireless_Paper_room_server',
      'RAK4631_repeater'
    ])
  })

  it('tolerates a missing include and never loops on a self-reference', () => {
    const files: Record<string, string> = {
      'platformio.ini': '[platformio]\nextra_configs = platformio.ini\n gone.ini\n[env:a]\nx = 1\n'
    }
    expect(
      collectEnvNames(
        (rel) => files[rel] ?? null,
        () => []
      )
    ).toEqual(['a'])
  })
})

describe('overrideConfigIni', () => {
  it('delegates to the user file and pins DIO per environment', () => {
    const ini = overrideConfigIni({
      userConfigPath: '/proj/platformio.ini',
      envs: ['esp32s3', 'other']
    })
    expect(ini).toContain('extra_configs = /proj/platformio.ini')
    expect(ini).toContain('[env:esp32s3]')
    expect(ini).toContain('[env:other]')
    expect(ini.match(/board_build\.flash_mode = dio/g)).toHaveLength(2)
    expect(ini).toContain('board_build.arduino.memory_type = dio_qspi')
  })

  it('keeps the PSRAM half octal for octal parts', () => {
    const ini = overrideConfigIni({
      userConfigPath: '/proj/platformio.ini',
      envs: ['ThinkNode_M9_companion_radio_usb_'],
      psramOctal: true
    })
    expect(ini).toContain('board_build.arduino.memory_type = dio_opi')
    expect(ini).not.toContain('dio_qspi')
  })
})

describe('usbBuildOverrideIni', () => {
  it('redirects build_dir and pins no flash mode', () => {
    const ini = usbBuildOverrideIni({
      userConfigPath: '/proj/platformio.ini',
      buildDir: '/cache/usb-build/proj'
    })
    expect(ini).toContain('extra_configs = /proj/platformio.ini')
    expect(ini).toContain('build_dir = /cache/usb-build/proj')
    expect(ini).not.toContain('flash_mode')
    expect(ini).not.toContain('memory_type')
    expect(ini).not.toContain('[env:')
  })
})
