import { describe, expect, it } from 'vitest'
import { overrideConfigIni, parseEnvNamesFromIni, parseProjectConfig } from './pio'

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
})
