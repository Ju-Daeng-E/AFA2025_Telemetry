import fs from 'fs';
import express from 'express';
import { Server } from 'socket.io';
import path from 'path';
import winston from 'winston';
import winstonDaily from 'winston-daily-rotate-file';
import { LOG_LEVEL, LOG_SOURCE, LOG_KEY, translate } from '../web/assets/types.js';
import logfilesRouter from './routes/logfiles.mjs';
import { fileURLToPath } from 'url';  // ES 모듈에서 __dirname 사용을 위해 필요

/*****************************************************************************
 * server configurations
 ****************************************************************************/

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.resolve();
let separateLogTransport = null;

app.use('/api', logfilesRouter);
app.use(express.static(path.join(__dirname, 'public'))); // 프론트엔드 파일 경로


const config = JSON.parse(fs.readFileSync('config.json'));

const server = app.listen(config.port, () => {
  logger.info('SERVER STARTUP', { port: config.port });
});
/*****************************************************************************
 * logger configurations
 ****************************************************************************/
const logger = winston.createLogger({
  transports: [
    new winstonDaily({
      level: 'info',
      datePattern: 'YYYY-MM-DD',
      dirname: './log',
      filename: `%DATE%.log`,
    })
  ],
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss.SSS'
    }),
    winston.format.json()
  ),
  exitOnError: false,
});

// 경로 정보 로깅
logger.info('Server started', {
  dirname: __dirname,
  typesJsPath: path.join(__dirname, '../web/assets/types.js'),
  publicPath: path.join(__dirname, 'public')
});

/*****************************************************************************
 * socket server configurations
 ****************************************************************************/
const io = new Server(server, {
  pingInterval: 3000,
  pingTimeout: 10000
});

/*****************************************************************************
 * socket event handlers
 ****************************************************************************/
io.sockets.on('connection', socket => {
  // verify channel
  console.log('Types.js 경로:', path.join(__dirname, '../web/assets/types.js'));
  console.log('Public 디렉토리 경로:', path.join(__dirname, 'public'));

  const channel = config.channels.find(x => x.name === socket.handshake.query.channel);
  if (!channel || (channel.key !== socket.handshake.query.key)) {
    socket.disconnect();
    logger.error('UNAUTHORIZED DEVICE', {
      id: socket.id,
      ip: socket.handshake.headers['x-forwarded-for'] || socket.handshake.address,
      channel: socket.handshake.query.channel,
      key: socket.handshake.query.key
    });
    return;
  }
  socket.on("start_log_recording", data => {
    const filename = data.filename;
    if (!separateLogTransport) {
      separateLogTransport = new winston.transports.File({
        level: 'info',
        dirname: './separated_logs',  // 별도 로그 저장 폴더 (미리 생성 필요)
        filename: `${filename}.log`,
        options: { flags: 'a' }
      });
      logger.add(separateLogTransport);
      logger.info("저장용 로그 기록 시작", { filename: filename });
    } else {
      // 이미 로그 기록 중인 경우, 새 요청은 무시하거나 알림 처리
      //logger.info("이미 별도 로그 기록 중입니다.", { filename: filename });
    }
  });

  // 로그 기록 정지 이벤트 처리
  socket.on("stop_log_recording", () => {
    if (separateLogTransport) {
      logger.info("별도 로그 기록 정지");
      logger.remove(separateLogTransport);
      if (typeof separateLogTransport.close === 'function') {
        separateLogTransport.close();
      }
      separateLogTransport = null;
    }
  });

  
  // TMA-1 device register
  if (socket.handshake.query.device) {
    register_device(socket);
  }

  // telemetry client register
  else if (socket.handshake.query.client) {
    register_client(socket);
  }

});

/*****************************************************************************
 * socket register functions
 ****************************************************************************/
function register_device(socket) {
  socket.join(socket.handshake.query.channel);

  logger.info('DEVICE CONNECTED', {
    id: socket.id,
    ip: socket.handshake.headers['x-forwarded-for'] || socket.handshake.address,
    channel: socket.handshake.query.channel
  });

  

  // emit RTC time fix
  setTimeout(() => socket.emit('rtc_fix', { datetime: new Date().toISOString() }), 1000);

  // Notify all clients about the device connection
  io.emit('device_connected', { message: "device connected" });

  // on SOCKET_DISCONNECTED
  socket.on('disconnect', reason => {
    logger.info('DEVICE DISCONNECTED', {
      id: socket.id,
      ip: socket.handshake.headers['x-forwarded-for'] || socket.handshake.address,
      channel: socket.handshake.query.channel
    });
    ECU.telemetry = false;
    ECU.car.system.ESP = false;
    
    socket.broadcast.to(socket.handshake.query.channel).emit('socket-lost', { data: reason });
  });

  // on telemetry report
  socket.on('tlog', data => {
    ECU.telemetry = true;
    ECU.car.system.ESP = true;
    process_telemetry(data, socket);
  });
}


function register_client(socket) {
  socket.join(socket.handshake.query.channel);

  logger.info('CLIENT CONNECTED', {
    id: socket.id,
    ip: socket.handshake.headers['x-forwarded-for'] || socket.handshake.address,
    channel: socket.handshake.query.channel
  });

  socket.emit('client_connected', {data: null, status: ECU});
  socket.on('reset-request', () => {
    if (ECU.telemetry) {
      socket.emit('reset-reply', {
        icon: 'error',
        title: '차량 상태 초기화 오류',
        html: `<code><i class="fa-duotone fa-fw fa-tower-broadcast" style="color: green"></i> 원격 계측</code> 활성화 상태에서는 차량 상태를 초기화할 수 없습니다.`,
        showCancelButton: true, showConfirmButton: false, cancelButtonText: '확인', cancelButtonColor: '#7066e0'
      });
    } else {
      socket.emit('reset-reply', {
        icon: 'warning',
        title: '차량 상태 초기화',
        html: `<code><i class="fa-duotone fa-fw fa-tower-broadcast" style="color: red"></i> 원격 계측</code> 비활성화 상태에서 남아있는 이전 데이터를 초기화합니다.`,
        showCancelButton: true, cancelButtonText: '취소', confirmButtonText: '확인', confirmButtonColor: '#d33',
        customClass: { confirmButton: 'swal2-two-buttons' }
      });
    }
  });

  socket.on('reset-confirm', () => {
    ECU = JSON.parse(ECU_INIT);
    io.to('client').emit('client_init', { data: null, status: ECU });
  });
}
  
/*****************************************************************************
 * telemetry report handler
 ****************************************************************************/
function process_telemetry(data, socket) {
  // corrupt telemetry data
  if (!('log' in data)) {
    return;
  }

  let raw = data.log;
  data = translate(data.log.match(/.{2}/g).map(x => parseInt(x, 16)));

  if (data instanceof Error) {
    logger.error('PARSE FAILED', {
      id: socket.id,
      ip: socket.handshake.headers['x-forwarded-for'] || socket.handshake.address,
      channel: socket.handshake.query.channel,
      data: data.toString(),
      raw: raw
    });

    return;
  }

  logger.info('REPORT', {
    id: socket.id,
    ip: socket.handshake.headers['x-forwarded-for'] || socket.handshake.address,
    channel: socket.handshake.query.channel,
    data: data,
    raw: raw
  });
  if (data != null) {
    switch (data.source) {
      case "ECU": {
        switch (data.key) {
          case "ECU_STATE": {
            ECU.car.system.HV = data.parsed.HV;
            ECU.car.system.RTD = data.parsed.RTD;
            ECU.car.system.BMS = data.parsed.BMS;
            ECU.car.system.IMD = data.parsed.IMD;
            ECU.car.system.BSPD = data.parsed.BSPD;

            ECU.car.system.ERR = data.parsed.ERR;
            ECU.car.system.SD = data.parsed.SD;
            ECU.car.system.TELEMETRY = data.parsed.TELEMETRY;
            ECU.car.system.CAN = data.parsed.CAN;
            break;
          }
          case "ECU_BOOT":
            break;
          case "ECU_READY":
            break;
          case "SD_INIT":
            break;
          default:
            break;
        }
        break;
      }
      case "ESP": break;
      case "CAN": {
        switch (data.key) {
          case "CAN_INV_TEMP_1": {
            ECU.inverter.temperature.igbt.max = data.parsed.igbt.max;
            ECU.inverter.temperature.gatedriver = data.parsed.gatedriver;
            break;
          }
          case "CAN_INV_TEMP_2": {
            // ECU.inverter.temperature.controlboard = data.parsed.controlboard;
            // ECU.inverter.temperature.rtd.rtd1 = data.parsed.RTD1;
            // ECU.inverter.temperature.rtd.rtd2 = data.parsed.RTD2;
            break;
          }
          case "CAN_INV_TEMP_3": {
            // ECU.inverter.temperature.coolant = data.parsed.coolant;
            ECU.inverter.temperature.hotspot = data.parsed.hotspot;
            ECU.inverter.temperature.motor = data.parsed.motor;
            break;
          }
          case "CAN_INV_ANALOG_IN": {
            ECU.car.accel = data.parsed.AIN1;
            ECU.car.brake = data.parsed.AIN3;
            break;
          }
          case "CAN_INV_MOTOR_POS": {
            ECU.inverter.motor.angle = data.parsed.motor_angle;
            ECU.inverter.motor.speed = data.parsed.motor_speed;
            ECU.car.speed = Math.PI * 0.4572 * 60 * data.parsed.motor_speed / (1000 * 4.941176);
            break;
          }
          case "CAN_INV_CURRENT": {
            ECU.inverter.current.dc_bus = data.parsed.dc_bus_current;
            break;
          }
          case "CAN_INV_VOLTAGE": {
            ECU.inverter.voltage.dc_bus = data.parsed.dc_bus_voltage;
            ECU.inverter.voltage.output = data.parsed.output_voltage;
            break;
          }
          case "CAN_INV_STATE": {
            ECU.inverter.state.vsm_state = state.vsm[data.parsed.vsm_state];
            ECU.inverter.state.inverter_state = state.inverter[data.parsed.inverter_state];
            ECU.inverter.state.relay.precharge = (data.parsed.relay_state & (1 << 0)) ? true : false;
            ECU.inverter.state.relay.main = (data.parsed.relay_state & (1 << 1)) ? true : false;
            ECU.inverter.state.relay.pump = (data.parsed.relay_state & (1 << 4)) ? true : false;
            ECU.inverter.state.relay.fan = (data.parsed.relay_state & (1 << 5)) ? true : false;
            ECU.inverter.state.mode = state.inverter_mode[data.parsed.inverter_run_mode];
            ECU.inverter.state.discharge = state.discharge_state[data.parsed.inverter_active_discharge_state];
            ECU.inverter.state.enabled = data.parsed.inverter_enable_state ? true : false;
            ECU.inverter.state.bms_comm = data.parsed.bms_active ? true : false;
            ECU.inverter.state.limit.bms = data.parsed.bms_limiting_torque ? true : false;
            ECU.inverter.state.limit.speed = data.parsed.limit_max_speed ? true : false;
            ECU.inverter.state.limit.hotspot = data.parsed.limit_hot_spot ? true : false;
            ECU.inverter.state.limit.lowspeed = data.parsed.low_speed_limiting ? true : false;
            ECU.inverter.state.limit.coolant = data.parsed.coolant_temperature_limiting ? true : false;
            break;
          }
          case "CAN_INV_FAULT": {
            ECU.inverter.fault.post = [];
            ECU.inverter.fault.run = [];
            for (let i = 0; i < 32; i++) {
              if (data.parsed.POST & (1 << i)) {
                ECU.inverter.fault.post.push(fault.post[i]);
              }
              if (data.parsed.RUN & (1 << i)) {
                ECU.inverter.fault.run.push(fault.run[i + 32]);
              }
            }
            break;
          }
          case "CAN_INV_TORQUE": {
            ECU.inverter.torque.feedback = data.parsed.torque_feedback;
            ECU.inverter.torque.commanded = data.parsed.commanded_torque;
            break;
          }
          case "CAN_BMS_CORE": {
            ECU.bms.charge = data.parsed.soc;
            ECU.bms.capacity = data.parsed.capacity;
            ECU.bms.voltage = data.parsed.voltage;
            ECU.bms.current = data.parsed.current;
            ECU.bms.failsafe = data.parsed.failsafe;
            break;
          }
          case "CAN_BMS_TEMP": {
            ECU.bms.temperature = data.parsed.temperature;
            ECU.bms.dcl = data.parsed.dcl;
            ECU.bms.ccl = data.parsed.ccl;
            break;
          }
          case "CAN_INV_DIGITAL_IN":
              break;
          case "CAN_INV_FLUX":
              break;
          case "CAN_INV_REF":
              break;
          case "CAN_INV_FLUX_WEAKING":
              break;
          case "CAN_INV_FIRMWARE_VER":
              break;
          case "CAN_INV_DIAGNOSTIC":
              break;
          case "CAN_INV_HIGH_SPD_MSG":
              break;
          case "CAN_STEERING_WHEEL_ANGLE":{
            ECU.car.steering.angle = data.parsed.angle;
            ECU.car.steering.speed = data.parsed.speed;
          }
          default:
            break;
        }
        break;
      }
      case "ADC": {
        switch (data.key) {
          case "ADC_CPU": {
            ECU.temperature = data.parsed.CPU_TEMP;
            break;
          }
          case "ADC_DIST": {
            ECU.car.position.FL = data.parsed.DIST_FL;
            ECU.car.position.RL = data.parsed.DIST_RL;
            ECU.car.position.FR = data.parsed.DIST_FR;
            ECU.car.position.RR = data.parsed.DIST_RR;
            break;
          }
          case "ADC_INIT":
          default:
            break;
        }
        break;
      }
      case "TIM": break;
      case "ACC": {
        switch (data.key) {
          case "ACC_DATA": {
            ECU.car.acceleration = data.parsed;
            break;
          }
          case "ACC_INIT":
              break;
          default:
            break;
        }
        break;
      }
      case "LCD": break;
      case "GPS": {
        switch (data.key) {
          case "GPS_POS": {
            ECU.car.gps.lat = data.parsed.lat;
            ECU.car.gps.lon = data.parsed.lon;
            break;
          }
          case "GPS_VEC": {
            ECU.car.gps.speed = data.parsed.speed;
            ECU.car.gps.course = data.parsed.course;
            break;
          }
          case "GPS_INIT":
            break;
          case "GPS_TIME":
            break;
          default:
            break;
        }
        break;
      }
    }
  socket.broadcast.to(socket.handshake.query.channel).emit('report', { data: data , status: ECU});
}
}
/*****************************************************************************
 * system state
 ****************************************************************************/
let ECU = {          // initial system status
  telemetry: false,
  session: null,
  temperature: 0,
  car: {
    system: {
      HV: false,
      RTD: false,
      BMS: false,
      IMD: false,
      BSPD: false,

      ERR: false,
      SD: false,
      TELEMETRY: false,
      CAN: false,

    },
    position: {
      FL: 0,
      RL: 0,
      FR: 0,
      RR: 0,
    },
    wheel_speed: {
      FL: 0,
      RL: 0,
      FR: 0,
      RR: 0,
    },
    acceleration: {
      x: 0,
      y: 0,
      z: 0,
    },
    gps: {
      lat: 0,
      lon: 0,
      speed: 0,
      course: 0,
    },
    speed: 0,
    accel: 0,
    brake: 0,
    steering: {
      speed: 0,
      angle: 0,
    }
  },
  inverter: {
    temperature: {
      igbt: {
        max: {
          temperature: 0,
          id: "X",
        }
      },
      rtd: {
        rtd1: 0,
        rtd2: 0,
      },
      gatedriver: 0,
      controlboard: 0,
      coolant: 0,
      hotspot: 0,
      motor: 0,
    },
    motor: {
      angle: 0,
      speed: 0,
    },
    current: {
      dc_bus: 0,
    },
    voltage: {
      dc_bus: 0,
      output: 0,
    },
    state: {
      vsm_state: "N/A",
      inverter_state: "N/A",
      relay: {
        precharge: false,
        main: false,
        pump: false,
        fan: false,
      },
      mode: "N/A",
      discharge: "N/A",
      enabled: false,
      bms_comm: false,
      limit: {
        bms: false,
        speed: false,
        hotspot: false,
        lowspeed: false,
        coolant: false
      }
    },
    fault: {
      post: [],
      run: [],
    },
    torque: {
      feedback: 0,
      commanded: 0,
    },
  },
  bms: {
    charge: 0,
    capacity: 0,
    voltage: 0,
    current: 0,
    ccl: 0,
    dcl: 0,
    failsafe: {
      voltage: false,
      current: false,
      relay: false,
      balancing: false,
      interlock: false,
      thermister: false,
      power: false,
    },
    temperature: {
      max: {
        value: 0,
        id: 0,
      },
      min: {
        value: 0,
        id: 0,
      },
      internal: 0,
    },
  },
}
const ECU_INIT = JSON.stringify(ECU);

const state = { // motor controller properties
  vsm: {
    0: "VSM 시작",
    1: "초기충전 준비",
    2: "초기충전",
    3: "초기충전 완료",
    4: "VSM 대기",
    5: "VSM 준비 완료",
    6: "모터 작동",
    7: "FAULT",
    14: "Shutdown",
    15: "Recycle Power"
  },
  inverter: {
    0: "Power On",
    1: "Stop",
    2: "Open Loop", 
    3: "Closed Loop", 
    4: "Wait",
    5: "Internal",
    6: "Internal", 
    7: "Internal",
    8: "Idle Run",
    9: "Idle Stop",
    10: "Internal",
    11: "Internal",
    12: "Internal"
  },
  discharge_state: {
    0: "방전 비활성화",
    1: "방전 대기",
    2: "속도 검사 중",
    3: "방전 중",
    4: "방전 완료",
  },
  inverter_mode: {
    0: "토크 모드",
    1: "속도 모드"
  }
}

const fault = { // motor controller fault properties
  post: {
    0: "Hardware Gate/Desaturation Fault",
    1: "HW Over-current Fault",
    2: "Accelerator Shorted",
    3: "Accelerator Open",
    4: "Current Sensor Low",
    5: "Current Sensor High",
    6: "Module Temperature Low",
    7: "Module Temperature High",
    8: "Control PCB Temperature Low",
    9: "Control PCB Temperature High",
    10: "Gate Drive PCB Temperature Low",
    11: "Gate Drive PCB Temperature High",
    12: "5V Sense Voltage Low",
    13: "5V Sense Voltage High",
    14: "12V Sense Voltage Low",
    15: "12V Sense Voltage High",
    16: "2.5V Sense Voltage Low",
    17: "2.5V Sense Voltage High",
    18: "1.5V Sense Voltage Low",
    19: "1.5V Sense Voltage High",
    20: "DC Bus Voltage High",
    21: "DC Bus Voltage Low",
    22: "Pre-charge Timeout",
    23: "Pre-charge Voltage Failure",
    24: "EEPROM Checksum Invalid",
    25: "EEPROM Data Out of Range",
    26: "EEPROM Update Required",
    27: "Hardware DC Bus Over-Voltage during initialization",
    28: "Reserved",
    29: "Reserved",
    30: "Brake Shorted",
    31: "Brake Open",
  },
  run: {
    32: "Motor Over-speed Fault",
    33: "Over-current Fault",
    34: "Over-voltage Fault",
    35: "Inverter Over-temperature Fault",
    36: "Accelerator Input Shorted Fault",
    37: "Accelerator Input Open Fault",
    38: "Direction Command Fault",
    39: "Inverter Response Time-out Fault",
    40: "Hardware Gate/Desaturation Fault",
    41: "Hardware Over-current Fault",
    42: "Under-voltage Fault",
    43: "CAN Command Message Lost Fault",
    44: "Motor Over-temperature Fault",
    45: "Reserved",
    46: "Reserved",
    47: "Reserved",
    48: "Brake Input Shorted Fault",
    49: "Brake Input Open Fault",
    50: "Module A Over-temperature Fault",
    51: "Module B Over-temperature Fault",
    52: "Module C Over-temperature Fault",
    53: "PCB Over-temperature Fault",
    54: "Gate Drive Board 1 Over-temperature Faul",
    55: "Gate Drive Board 2 Over-temperature Fault",
    56: "Gate Drive Board 3 Over-temperature Fault",
    57: "Current Sensor Fault",
    58: "Reserved",
    59: "Hardware DC Bus Over-Voltage Fault",
    60: "Reserved",
    61: "Reserved",
    62: "Resolver Not Connected",
    63: "Reserved",
  }
}

