/**
 * rtc功能SDK，created by lduoduo
 * 注：API目前还在完善中，尚未完成!
 * 功能：通过rtc帮助传输媒体流和data数据
 * 调用方式：
 * 1. 新建实例 var rtc = new rtcSDK()
 * 2. 初始化，可以传入媒体流或者data数据，可选
 *      rtc.init({
 *          url: 信令服务器地址，必填
 *          roomId: 房间号码，必填
 *          debug: false, 是否开启debug，主要针对移动端弹框显示,默认不开启
 *          mediastream: 媒体流，可选
 *          data: 自定义data数据，可选
 *      }).then(supportedListeners=>{
 *          // 回调返回的supportedListeners是目前SDK支持的事件注册名
 *          console.log('支持的事件注册列表:',supportedListeners)
 *      })
 *    初始化成功之后，会有属性标志位:inited:true
 * 3. 注册回调监听函数
 *      // 监听远程媒体流
 *      rtc.on('stream', function (mediastream) {
 *          console.log(mediastream)
 *      }.bind(this))
 *      rtc.on('data', function (data) {
 *          console.log(data)
 *      }.bind(this))
 *      // 连接成功回调
 *      rtc.on('ready', function (obj) {
 *          let {status, error, wss} = obj
 *          status: 连接成功失败的状态
 *          console.log(obj)
 *      }.bind(this))
 *      // 远程断开监听
 *      rtc.on('stop', function (obj) {
 *          console.log(obj)
 *      }.bind(this))
 * 4. 可调用的方法
 *      - rtc.updateStream(stream) // 更新流，用新的流代替旧的流，如果不传参，代表销毁流
 *      - rtc.sendMessage(data) // 发送文字聊天
 *      - rtc.sendFile(file) // 发送文件
 *      - rtc.sendText(data) // 发送自定义纯文本
 *      - rtc.updateData(data) // 传递自定义数据，目前没有任何限制(已废弃，不推荐使用)
 * 5. 本地日志颜色搭配
 *      - 有活动：黄色
 *      - 本地信息: 蓝色
 *      - 远程信息: 绿色 
 */

/******************************SDK START************************************ */

// import Logger from './log.js'
require('webrtc-adapter')
require('es6-promise').polyfill();
const sdpTransform = window.sdpTransform = require('sdp-transform')
const support = require('./rtcPolify');
const signal = require('./rtcSignal');
const sdpUtil = require('./rtcSdpUtil');
import RtcStats from './rtcStats';

// 不允许改的属性, rtc当前的状态
const RTC_STATUS = {
    'new': '0', // 刚初始化，还未开启
    'opened': '1', // 已开启，还未连接
    'connected': '2' //双方连接成功
}

// 指定dataChannel数据发送的规则
const RTC_DATA_TYPE = {
    'text': '1', // '纯文本数据,默认类型,对端接收只打印不作处理',
    'notify': '2', //'通知类数据,场景：发送特殊格式的数据需要提前告知对方注意接收',
    'command': '3', //'命令相关，向后扩展白板等',
    'message': '4', //'聊天内容',
    'other': '5' //'替补类型,暂时无用,未完待续'
}

// 指定dataChannel数据发送的规则的反解析
const RTC_DATA_TYPE_RV = {
    1: 'text', // '纯文本数据,默认类型,对端接收只打印不作处理',
    2: 'notify', //'通知类数据,场景：发送特殊格式的数据需要提前告知对方注意接收',
    3: 'command', //'命令相关，向后扩展白板等',
    4: 'message', //'聊天内容',
    5: 'other' //'替补类型,暂时无用,未完待续'
}

// 指定dataChannel接收数据后的方法分发
const RTC_DATA_TYPE_FN = {
    'text': 'onText', // '纯文本数据, 默认类型, 对端接收只打印不作处理',
    'notify': 'onNotify', //'通知类数据,场景：发送特殊格式的数据需要提前告知对方注意接收',
    'command': 'onCommand', //'命令相关，向后扩展白板等',
    'message': 'onMessage', //'聊天内容',
    'other': 'onOther' //'替补类型,暂时无用,未完待续'
}

// 开始构造函数
function rtcSDK() {
    this.rtcConnection = null;
    // 默认开启的长连接通道
    this.dataChannel = null;
    // 特殊需求时候开启的别的通道
    this.rtcDataChannels = {};
    // 待发送的iceoffer
    this.ice_offer = [];
    // ice交换完毕
    this.ice_completed = false;
    // 是否是重新连接, 当服务器断开之后进行重连
    this.isReconect = false;
    // 是否是重新初始化rtc, 当对方离开之后重新初始化
    this.isReSetup = false;
    this.stream = null;
    this.inited = false;
    this.wss = null;
    // 状态：刚初始化
    this.rtcStatus = RTC_STATUS['new'];

    this.supportedListeners = {
        'ready': '连接成功的回调',
        'connected': '点对点webrtc连接成功的回调',
        'stream': '收到远端流',
        'data': '收到远端datachannel数据',
        'stop': '连接断开',
        'leave': '对方离开',
        'text': '收到纯文本消息',
        'message': '收到聊天信息',
        'command': '收到指令',
        'notify': '收到通知',
        'sendFile': '文件发送中的实时状态',
        'receiveFile': '文件接收中的实时状态',
        'sendBuffer': '发送ArrayBuffer实时状态',
        'receiveBuffer': '接收ArrayBuffer实时状态',
        'sendBlob': '发送Blob实时状态',
        'receiveBlob': '接收Blob实时状态'
    }
    // 回调监听
    this.listeners = {}

    this.duoduo_signal = signal
}

rtcSDK.prototype = {
    // 临时的远程数据，用于存放接收特殊格式数据，数据接收完毕回传后删除!
    remoteTMP: {},
    // 注册监听回调事件
    on(name, fn) {
        this.listeners[name] = fn
    },
    // 执行回调
    emit(name, data) {
        this.listeners[name] && this.listeners[name](data)
    },
    // 初始化入口
    init(option = {}) {
        // 先校验平台适配情况
        if (!support.support) return Promise.reject('当前浏览器不支持WebRTC功能')

        let { url, roomId, stream, data, debug } = option

        if (!url) return Promise.reject('缺少wss信令地址')
        if (!roomId) return Promise.reject('缺少房间号码')

        this.tmpStream = stream;
        this.data = data;
        this.debug = debug || false;

        if (this.inited) {
            this.updateStream()
            return Promise.reject('请勿重复开启rtc连接')
        }

        this.duoduo_signal.init({ url, roomId });

        if (this.isReconect) {
            return Promise.resolve()
        }

        this.duoduo_signal.on('connected', this.connected.bind(this))
        this.duoduo_signal.on('start', this.start.bind(this))
        this.duoduo_signal.on('leave', this.leave.bind(this))
        this.duoduo_signal.on('stop', this.stop.bind(this))
        this.duoduo_signal.on('candidate', this.onNewPeer.bind(this))
        this.duoduo_signal.on('offer', this.onOffer.bind(this))
        this.duoduo_signal.on('answer', this.onAnswer.bind(this))

        return Promise.resolve(this.supportedListeners)
    },
    // 对方离开，清空当前rtc状态，重置
    leave(data) {
        if (!this.inited) return
        this.emit('leave', data)
        this.rtcConnection.close();
        this.isReSetup = true;
        // 重新开启准备工作
        this.setup()
    },
    // 断开连接, 进行销毁工作
    stop(data) {
        if (!this.inited) return

        this.emit('stop', data)

        if (this.dataChannel) this.closeChannel(this.dataChannel)

        for (let i in this.rtcDataChannels) {
            this.closeChannel(this.rtcDataChannels[i])
        }

        if (this.rtcConnection && this.rtcConnection.signalingState !== 'closed') this.rtcConnection.close()

        this.rtcConnection = null
        this.dataChannel = null
        this.rtcDataChannels = {}

        this.duoduo_signal.stop()

        let stream = this.stream
        if (stream) {
            stream.getTracks().forEach(function (track) {
                stream.removeTrack(track)
            })
        }
        this.stream = null
        this.listeners = {}
        this.inited = false

        this.isReSetup = false;
        this.isReconect = true;

    },
    connected(option = {}) {
        let { status, wss, error } = option
        if (status) {
            this.setup(wss)
            return
        }
        this.emit('ready', { status: false, error })
    },
    // 初始化rtc连接，做准备工作
    setup(wss) {
        let rtcConnection;

        this.wss = wss || this.wss;

        //Google的STUN服务器：stun:stun.l.google.com:19302 ??
        let iceServer = {
            "iceServers": [{
                "urls": "stun:173.194.202.127:19302"
            }]
        };

        let optional = [{
            // DTLS/SRTP is preferred on chrome
            // to interop with Firefox
            // which supports them by default
            DtlsSrtpKeyAgreement: true
        },
        {
            googCpuOveruseDetection: false
        }];

        rtcConnection = this.rtcConnection = new RTCPeerConnection(iceServer, { optional });

        //chrome
        // if (navigator.mozGetUserMedia) {
        //     rtcConnection = this.rtcConnection = new RTCPeerConnection(iceServer);
        // } else {
        //     rtcConnection = this.rtcConnection = new RTCPeerConnection(iceServer, {
        //         optional: [{
        //             googCpuOveruseDetection: false
        //         }, {
        //             // DTLS/SRTP is preferred on chrome
        //             // to interop with Firefox
        //             // which supports them by default
        //             DtlsSrtpKeyAgreement: true
        //         }
        //         ]
        //     });
        // }

        logger.info(`${this.getDate()} setup peerconnection`);
        /** 初始化成功的标志位 */
        this.inited = true;

        let stream = this.tmpStream
        if (stream) {
            // stream.getTracks().forEach((track) => {
            //     rtcConnection.addTrack(track, stream)
            // })
            this.updateStream(stream)
            // console.log(`${this.getDate()} attach stream:`, stream, stream.getTracks())
        }

        // 开启datachannel通道
        this.dataChannel = rtcConnection.createDataChannel("ldodo", { negotiated: true });
        this.onDataChannel(this.dataChannel);

        this.initPeerEvent();

        this.rtcStatus = RTC_STATUS['opened']

        if (this.isReSetup) return
        this.emit('ready', { status: true, url: wss })

        // 暂时屏蔽
        // this.initStats()
    },
    // 初始化注册peer系列监听事件
    initPeerEvent() {
        let rtcConnection = this.rtcConnection, that = this;

        // 远端流附加了轨道
        rtcConnection.ontrack = function (event) {
            let track = event.track
            logger.log(`${that.getDate()} on remote track`, track);
        };

        /** 远端流过来了, 新建video标签显示 */
        rtcConnection.onaddstream = function (event) {

            that.onRemoteStream(event)
        };

        rtcConnection.onremovestream = function (e) {

            logger.warn(`${that.getDate()} on remove stream`, arguments);
        }

        /** 设置本地sdp触发本地ice */
        rtcConnection.onicecandidate = function (event) {

            if (event.candidate) {
                // 丢掉TCP，只保留UDP
                if (/tcp/.test(event.candidate.candidate)) return

                console.log(`${that.getDate()} on local ICE: `, event.candidate);

                if (that.ice_completed) return

                // that.duoduo_signal.send('candidate', event.candidate);

                // 先缓存，在sdp_answer回来之后再发ice_offer
                if (that.localOffer) {
                    that.ice_offer.push(event.candidate)
                } else {
                    that.duoduo_signal.send('candidate', event.candidate);
                }

            } else {
                console.log(`${that.getDate()} onicecandidate end`);
            }
        };

        rtcConnection.onnegotiationneeded = function (event) {
            console.log(`${that.getDate()} onnegotiationneeded`);
        };

        /** 对接收方的数据传递设置 */
        rtcConnection.ondatachannel = function (e) {
            let id = e.channel.id
            let label = e.channel.label

            logger.log(`${that.getDate()} on remote data channel ${label} ---> ${id}`);

            that.rtcDataChannels[label] = e.channel
            logger.log(`${that.getDate()} data channel state: ${e.channel.readyState}`);

            // 对接收到的通道进行事件注册!
            that.onDataChannel(that.rtcDataChannels[label]);
        };

        rtcConnection.oniceconnectionstatechange = function () {
            let state = rtcConnection.iceConnectionState
            logger.info(`${that.getDate()} ice connection state change to: ${state}`);
            if (state === 'connected') {
                logger.log(`${that.getDate()} rtc connect success`)
                that.rtcStatus = RTC_STATUS['connected']
                that.emit('connected')
                // that.rtcStats.start()
            }
            if(state === 'closed'){
                logger.error(`${that.getDate()} rtc connect fail`)
                // that.rtcStats.stop()
            }
            if (that.dataChannel) {
                logger.info(`${that.getDate()} data channel state: ${that.dataChannel.readyState}`);
            }
        };
    },
    // 初始化stats
    initStats() {
        this.rtcStats = new RtcStats({ peer: this.rtcConnection, interval: 10000 })
        this.rtcStats.on('stats', function (result) {
            // console.log(result)
        })
    },
    // stats数据展示
    previewGetStatsResult(result) {
        console.log(result)
    },
    // 真正开始连接
    start() {

        logger.info(`${this.getDate()} 开始连接, 发出链接邀请`);
        let rtcConnection = this.rtcConnection
        // let that = this

        this.createOffer().catch(err => {
            console.error(err)
        })

    },
    /***************************************sdp协议的操作 start*************************************** */
    // 发起offer呼叫
    createOffer() {
        // let that = this
        let rtcConnection = this.rtcConnection
        let config = {
            offerToReceiveAudio: 1,
            offerToReceiveVideo: 1,
            // voiceActivityDetection: false,
            // iceRestart: true
        };
        logger.warn('\r\n-------------------------ldodo: activity start----------------------------\r\n')
        return rtcConnection.createOffer(config).then((_offer) => {

            this.localOffer = _offer
            // 协议更改，统一H264编解码格式
            _offer.sdp = sdpUtil.maybePreferVideoReceiveCodec(_offer.sdp, { videoRecvCodec: 'H264' });

            // 测试打印sdp!后期删除1
            if (this.debug) {
                Mt.alert({
                    title: 'offer',
                    msg: `<div style="text-align:left;">${sdp(_offer.sdp)}</div>`,
                    html: true,
                    confirmBtnMsg: '好'
                });
            }

            _offer = this.formatLocalDescription('local', _offer)

            return this.setLocalDescription('offer', _offer).then(() => {
                // console.log(`${this.getDate()} setLocalDescription offer:`, rtcConnection.localDescription)
                this.duoduo_signal.send('offer', _offer);
                return Promise.resolve()
            })

        }).catch((error) => {

            console.error(`${this.getDate()} An error on startPeerConnection:`, error)
            let offer = rtcConnection.localDescription
            if (!offer) return Promise.reject('no offer');

            return this.setLocalDescription('offer', offer).then(() => {
                // console.log(`${this.getDate()} still setLocalDescription offer:`, rtcConnection.localDescription)
                this.duoduo_signal.send('offer', offer);
                return Promise.resolve()
            })

        })
    },
    // 回复应答
    createAnswer() {
        let that = this
        let rtcConnection = this.rtcConnection

        return rtcConnection.createAnswer().then((_answer) => {

            logger.info(`${that.getDate()} create answer:`, _answer)

            // 协议更改，统一H264编解码格式
            _answer.sdp = sdpUtil.maybePreferVideoReceiveCodec(_answer.sdp, { videoRecvCodec: 'H264' });
            // 改动请见：https://stackoverflow.com/questions/34095194/web-rtc-renegotiation-errors
            _answer.sdp = _answer.sdp.replace(/a=setup:active/gi, function (item) {
                return 'a=setup:passive'
            })

            // 测试打印sdp!后期删除1
            if (that.debug) {
                Mt.alert({
                    title: 'answer',
                    msg: `<div style="text-align:left;">${sdp(_answer.sdp)}</div>`,
                    html: true,
                    confirmBtnMsg: '好'
                });
            }

            // _answer = this.formatLocalDescription('local', _answer)

            if (!_answer) return
            return that.setLocalDescription('answer', _answer).then(() => {
                // console.log(`${that.getDate()} setLocalDescription answer:`, rtcConnection.localDescription)
                that.duoduo_signal.send('answer', _answer);

                // check remote stream status
                that.checkRemoteStreamStatus()
                that.checkICE()
                return Promise.resolve();
            })
        })
    },
    /**
     * 格式化sdp, 在create offer之后, 设置之前格式化
     * 主要格式化内容: 
     * @param {any} localRemote remote/local 
     * @param {any} data sdp内容
     * @returns 
     */
    formatLocalDescription(localRemote, data) {

        let sdp_data = data
        let type = sdp_data.type

        let sdp_diff

        // 远程offer，本地answer
        if (type == 'offer' && localRemote === 'remote') {
            sdp_diff = this.rtcConnection.localDescription
        }

        // 本地offer，远程answer
        if (type === 'offer' && localRemote === 'local') {
            sdp_diff = this.rtcConnection.remoteDescription
        }

        // 本地answer，远程offer
        if (type === 'answer' && localRemote === 'local') {
            sdp_diff = this.rtcConnection.remoteDescription
        }

        let sdp_data_parse = sdpTransform.parse(sdp_data.sdp)
        let sdp_diff_parse = sdp_diff && sdpTransform.parse(sdp_diff.sdp)

        logger.info('更新前 sdp_data', sdp_data.type, sdp_data_parse)
        logger.info('更新前 sdp_diff', sdp_diff && sdp_diff.type, sdp_diff_parse)

        //test
        // if (true) return data

        if (!sdp_data_parse.media) return

        // 获取音轨和视轨
        let stream = this.rtcConnection.getLocalStreams()
        stream = stream[0] || new MediaStream()
        let audio = stream.getAudioTracks()[0]
        let video = stream.getVideoTracks()[0]
        let cname = ''

        sdp_data_parse.media.forEach((media, index) => {

            media.candidates && delete media.candidates
            // offer对ssrc做限制，如果没有视频或者音频，删除ssrc属性(firefox无论有无都有ssrc)
            if (media.type === 'audio') {
                !audio && delete media.ssrcs && delete media.ssrcGroups && delete media.msid
                let tmp = media.ssrcs && media.ssrcs.filter((item)=>{
                    return item.attribute === 'cname'
                })
                cname = tmp && tmp[0].value
            }
            if (media.type === 'video') {
                !video && delete media.ssrcs && delete media.ssrcGroups && delete media.msid
            }

            // 添加带宽限制
            // b=AS:800
            if (!navigator.mozGetUserMedia) {
                media.bandwidth = [{
                    type: 'AS',
                    limit: 800
                }]
            } else {
                media.bandwidth = [{
                    type: 'TIAS',
                    limit: 800
                }]
            }

            // firefox生成的answer里面针对dataChannel会多一行这个，进行删除
            if (media.type === 'application') {
                delete media.direction
            }

            // 针对answer的协议做修改,如果对方要求sendrecv,而自己没有流,则应该为inactive
            if (type === 'answer' && sdp_diff_parse) {
                let direction_diff = sdp_diff_parse.media[index].direction
                if (/(sendrecv|recvonly)/.test(direction_diff)) {

                    if (media.type === 'audio' && !audio) {
                        media.direction = 'inactive'
                    }
                    if (media.type === 'video' && !video) {
                        media.direction = 'inactive'
                    }

                }
            }

            // 针对offer的协议做修改, 根据实际流情况添加ssrc
            if(type === 'offer' && media.type === "video"){
                if(!video || media.ssrcs) return
                media.direction = 'sendrecv'
                // 添加ssrc
                media.ssrcs = []
                let ssrcid = sdpUtil.randomSSRC()
                
                media.ssrcs.push({
                    attribute:'cname',
                    id:ssrcid,
                    value: cname
                })

                media.ssrcs.push({
                    attribute:'msid',
                    id:ssrcid,
                    value: stream.id + ' ' + video.id
                })

                media.ssrcs.push({
                    attribute:'mslabel',
                    id:ssrcid,
                    value: stream.id
                })

                media.ssrcs.push({
                    attribute:'label',
                    id:ssrcid,
                    value:video.id
                })
                
                // media.ssrcGroups = []
                // media.ssrcGroups.push({
                //     semantics: 'FID',
                //     ssrcs: ssrcid
                // })
            }
        })

        logger.log('更新后 sdp_data', sdp_data_parse)

        sdp_data.sdp = sdpTransform.write(sdp_data_parse)

        return sdp_data

    },
    /**
     * 设置本地会话内容sdp
     * 
     * @param {any} type offer还是answer
     * @param {any} data sdp内容
     * @returns {Promise}
     */
    setLocalDescription(type, data) {
        let rtcConnection = this.rtcConnection
        logger.info(`${this.getDate()} setLocalDescription ${type}:\n`, sdpTransform.parse(data.sdp))
        logger.info(`\n`, data.sdp)
        return rtcConnection.setLocalDescription(new RTCSessionDescription(data))
    },
    setRemoteDescription(type, data) {
        let rtcConnection = this.rtcConnection
        logger.log(`${this.getDate()} setRemoteDescription ${type}:\n`, sdpTransform.parse(data.sdp))
        logger.log(`\n`, data.sdp)
        return rtcConnection.setRemoteDescription(new RTCSessionDescription(data))
    },
    /** 将对方加入自己的候选者中 */
    onNewPeer(candidate) {
        // var candidate = data.data;
        logger.log(`${this.getDate()} on remote ICE`, candidate)
        this.rtcConnection.addIceCandidate(new RTCIceCandidate(candidate));
    },
    /** 接收链接邀请，发出响应 */
    onOffer(offer) {

        logger.warn('\r\n-------------------------ldodo: activity start----------------------------\r\n')

        logger.log(`${this.getDate()} on remote offer`, offer);

        // 协议更改，统一H264编解码格式
        offer.sdp = sdpUtil.maybePreferVideoSendCodec(offer.sdp, { videoRecvCodec: 'H264' });

        this.setRemoteDescription('offer', offer).then(() => {
            return this.createAnswer()
        }).catch((error) => {
            console.error(`${this.getDate()} onOffer error:`, error)
        })
    },
    /** 接收响应，设置远程的peer session */
    onAnswer(answer) {
        logger.info(`${this.getDate()} on remote answer`, answer)

        // 协议更改，统一H264编解码格式
        answer.sdp = sdpUtil.maybePreferVideoSendCodec(answer.sdp, { videoRecvCodec: 'H264' });

        this.formatLocalDescription('remote', answer)
        // if (!answer) return

        this.setRemoteDescription('answer', answer).then(() => {
            this.localOffer = null

            this.checkICE()
        }).catch(function (e) {
            console.error(e);
        });
    },
    /***************************************sdp协议的操作 end*************************************** */
    /***************************************媒体流的操作 start*************************************** */
    updateStream(stream) {
        if (!stream) return
        if (stream.stream) stream = stream.stream

        let rtcConnection = this.rtcConnection
        let rtcStream = this.stream
        var audioOld, videoOld, audio, video

        audio = stream.getAudioTracks()[0]
        video = stream.getVideoTracks()[0]

        let tmp = rtcConnection.getLocalStreams()
        tmp = tmp.length > 0 ? tmp[0] : null
        logger.info('当前rtc 流id 和 轨道数目', tmp && tmp.id, (tmp && tmp.getTracks().length))
        tmp && tmp.getTracks().forEach(item => {
            console.log('   > 轨道id:', `${item.kind}:${item.id}`)
        })

        // 第一次附加
        if (!tmp) {
            // rtcStream = new MediaStream()
            // rtcConnection.addStream(rtcStream)

            this.addAudioTrack(stream)
            this.addVideoTrack(stream)

            tmp = rtcConnection.getLocalStreams()
            tmp = tmp.length > 0 ? tmp[0] : null
            logger.info('更新后rtc 流id 和 轨道数目', tmp && tmp.id, (tmp && tmp.getTracks().length))
            tmp && tmp.getTracks().forEach(item => {
                console.log('   > 轨道id:', `${item.kind} --> ${item.id}`)
            })

            window.rtcLocalStream = tmp

            if (this.rtcStatus === RTC_STATUS['connected']) {
                this.createOffer()
            }
            // window.myRtcStream = this.stream
            return
        }

        // 先取所有轨道
        audioOld = rtcStream && rtcStream.getAudioTracks()[0]
        videoOld = rtcStream && rtcStream.getVideoTracks()[0]
        audio = stream.getAudioTracks()[0]
        video = stream.getVideoTracks()[0]

        // 新加轨道
        if (!audioOld) {
            if (audio) {
                this.addAudioTrack(stream)
            }
        }

        if (!videoOld) {
            if (video) {
                this.addVideoTrack(stream)
            }
        }

        // 更新音频轨道
        if (audioOld) {
            // 移除轨道
            if (!audio) {
                this.removeAudioTrack()
            } else {
                // 更新轨道
                audio !== audioOld && this.updateAudioTrack(stream)
            }
        }

        // 更新视频轨道
        if (videoOld) {
            // 移除轨道
            if (!video) {
                this.removeVideoTrack()
            } else {
                video !== videoOld && this.updateVideoTrack(stream)
            }
        }

        tmp = rtcConnection.getLocalStreams()
        tmp = tmp.length > 0 ? tmp[0] : null
        console.log('更新后rtc 流id 和 轨道数目', tmp && tmp.id, (tmp && tmp.getTracks().length))
        tmp && tmp.getTracks().forEach(item => {
            console.log('   > 轨道id:', `${item.kind} -->  ${item.id}`)
        })

        window.rtcLocalStream = tmp

        if (this.rtcStatus === RTC_STATUS['connected']) {
            this.createOffer()
        }
    },
    // 移除视频
    removeVideoTrack() {
        let rtcConnection = this.rtcConnection
        let rtcStream = this.stream
        if (!rtcStream) return
        let videoTrack = rtcStream.getVideoTracks()[0]
        let isFirefox = !!navigator.mozGetUserMedia

        if (!videoTrack) {
            console.warn('removeVideo() | no video track')

            return Promise.reject(new Error('no video track'))
        }

        // videoTrack.stop()
        rtcStream.removeTrack(videoTrack)

        // New API. 为啥验证不用rtcConnection.removeTrack?, chrome也支持，只不过表现很怪异
        if (isFirefox) {
            let sender

            for (sender of rtcConnection.getSenders()) {
                if (sender.track === videoTrack) break
            }
            rtcConnection.removeTrack(sender)
        } else {
            // Old API.
            // rtcConnection.removeStream(rtcStream)
            // rtcConnection.addStream(rtcStream)
        }
    },
    // 添加视频
    addVideoTrack(newStream) {
        let rtcConnection = this.rtcConnection
        let rtcStream = this.stream
        let rtcStreamUpdate = rtcStream
        let newVideoTrack = newStream.getVideoTracks()[0]
        let isFirefox = !!navigator.mozGetUserMedia

        if (!newVideoTrack) return

        if (!rtcStream) {
            rtcStream = new MediaStream()
            this.stream = rtcStream
        }

        rtcStream.addTrack(newVideoTrack)

        // New API. 为啥验证不用rtcConnection.addTrack?, chrome也支持，只不过表现很怪异
        if (isFirefox) {
            rtcConnection.addTrack(newVideoTrack, rtcStream)
        } else {
            // Old API.
            !rtcStreamUpdate && rtcConnection.addStream(rtcStream)
        }
    },
    // 更新视频
    updateVideoTrack(newStream) {
        let rtcConnection = this.rtcConnection
        let rtcStream = this.stream
        if (!rtcStream) return
        let isFirefox = !!navigator.mozGetUserMedia

        // For Chrome (old WenRTC API).
        // Replace the track (so new SSRC) and renegotiate.
        if (!isFirefox) {
            this.removeVideoTrack(true)
            return this.addVideoTrack()
        }

        // For Firefox (modern WebRTC API).
        // Avoid renegotiation.
        let newVideoTrack = newStream.getVideoTracks()[0]
        let oldVideoTrack = rtcStream.getVideoTracks()[0]
        let sender

        for (sender of rtcConnection.getSenders()) {
            if (sender.track === oldVideoTrack) break
        }

        sender.replaceTrack(newVideoTrack)
        rtcStream.removeTrack(oldVideoTrack)
        // oldVideoTrack.stop()
        rtcStream.addTrack(newVideoTrack)
    },
    // 移除音频
    removeAudioTrack() {
        let rtcConnection = this.rtcConnection
        let rtcStream = this.stream
        let audioTrack = rtcStream.getAudioTracks()[0]
        let isFirefox = !!navigator.mozGetUserMedia

        if (!audioTrack) {
            console.warn('removeAudio() | no audio track')

            return Promise.reject(new Error('no audio track'))
        }

        // audioTrack.stop()
        rtcStream.removeTrack(audioTrack)

        // New API. 为啥验证不用rtcConnection.removeTrack?, chrome也支持，只不过表现很怪异
        if (isFirefox) {
            let sender

            for (sender of rtcConnection.getSenders()) {
                if (sender.track === audioTrack) break
            }
            rtcConnection.removeTrack(sender)
        } else {
            // Old API.
            // rtcConnection.removeStream(rtcStream)
            // rtcConnection.addStream(rtcStream)
        }
    },
    // 添加音频
    addAudioTrack(newStream) {
        let rtcConnection = this.rtcConnection
        let rtcStream = this.stream
        let rtcStreamUpdate = rtcStream
        let isFirefox = !!navigator.mozGetUserMedia
        let newAudioTrack = newStream.getAudioTracks()[0]

        if (!newAudioTrack) return

        if (!rtcStream) {
            rtcStream = new MediaStream()
            this.stream = rtcStream
        }

        rtcStream.addTrack(newAudioTrack)

        // New API. 为啥验证不用rtcConnection.addTrack?, chrome也支持，只不过表现很怪异
        if (isFirefox) {
            rtcConnection.addTrack(newAudioTrack, rtcStream)
        } else {
            // Old API.
            !rtcStreamUpdate && rtcConnection.addStream(rtcStream)
        }
    },
    // 更新音频
    updateAudioTrack(newStream) {
        let rtcConnection = this.rtcConnection
        let rtcStream = this.stream
        let isFirefox = !!navigator.mozGetUserMedia

        if (!rtcStream) return

        // For Chrome (old WenRTC API).
        // Replace the track (so new SSRC) and renegotiate.
        if (!isFirefox) {
            this.removeAudioTrack(true)
            return this.addAudioTrack()
        }

        // For Firefox (modern WebRTC API).
        // Avoid renegotiation.
        let newAudioTrack = newStream.getAudioTracks()[0]
        let oldAudioTrack = rtcStream.getAudioTracks()[0]
        let sender

        for (sender of rtcConnection.getSenders()) {
            if (sender.track === oldAudioTrack) break
        }

        sender.replaceTrack(newAudioTrack)
        rtcStream.removeTrack(oldAudioTrack)
        // oldAudioTrack.stop()
        rtcStream.addTrack(newAudioTrack)
    },
    /***************************************媒体流的操作 end*************************************** */
    // 远程流监控
    onRemoteStream(event) {

        let stream = event.stream
        window.rtcRemoteStream = stream
        if (!stream) return

        logger.log(`${this.getDate()} get remote stream`, stream);

        stream && stream.getTracks().forEach(item => {
            console.log('   > 轨道id:', `${item.kind} -->  ${item.id}`)
        })

        this.emit('stream', stream)

        stream.onaddtrack = e => {
            logger.log(`${this.getDate()} on add track`, e)
        }

        stream.onremovetrack = e => {
            logger.warn(`${this.getDate()} on remove track`, e)
        }
    },
    // 每当对方sdp协议发生变动，主动检查远程媒体流的状态，该方法用于修复firefox无法获知removeTrack事件
    // Hack for Firefox bug:
    // https://bugzilla.mozilla.org/show_bug.cgi?id=1347578
    checkRemoteStreamStatus() {

    },
    // 为了保证offer / answer / iceoffer / iceanswer的顺序，这里拎出来处理
    checkICE() {
        // 开始发送ice_offer
        let iceOffers = this.ice_offer
        if (iceOffers.length > 0) {
            iceOffers.forEach((item) => {
                this.duoduo_signal.send('candidate', item);
            })
        }
        this.ice_offer = []
    },
    // 实时更新data
    /**
     * 实时更新data
     * 需要对数据格式做验证
     * 1. blob格式的传输，新建Blob通道，最后一次传输完毕进行关闭
     * 2. arraybuffer格式的传输，新建arraybuffer通道，最后一次传输完毕进行关闭
     * 3. 其他格式的数据通通以json格式传输，默认只开启一个长连接通道进行传输
     * 4. 这里需要注意频繁关闭通道会不会有性能问题，需要调研!
     * 5. 对于特殊格式的数据，需要包装一下，注明type和通道id
     * 这里需要返回一个promise，用于记录如果是特殊格式的传输回传的通道id
     * 参数注解:
     * 注: 当特殊格式的数据传输完毕，请手动调用一次，data.data设置为Null
     * {
            type: '数据类型', // 自定义，用于接收端解析
            channelType: '通道类型', // 注明是ArrayBuffer还是Blob，如果这两种都不是，不用注明
            channelId: '通道id', //当传真正的特殊格式数据时，需要传递该参数
            data: Any //真正需要传递的数据
        }
        注：销毁通道由接收方进行
        注：如果需要申请长连接，创建后不再关闭通道，需要传递一个参数 channelLife: 'long'，默认是短连接
        注：接口已废弃20170720, 不再使用
     */
    updateData(data) {
        let that = this
        if (!this.rtcConnection || !this.dataChannel) return Promise.reject('no rtc connection')
        if (data.constructor === Object) {
            // 是否是特殊格式的传输
            if (data.data && /(Blob|ArrayBuffer)/.test(data.data.constructor)) {
                if (!data.channelId) return Promise.reject('no channelId')
                let tmp = this.rtcDataChannels[data.channelId]
                console.log(`${this.getDate()} send ArrayBuffer`)

                if (!tmp || tmp.readyState !== 'open') {
                    return Promise.reject(`${tmp ? 'dataChannel state error:' + tmp.readyState : 'dataChannel destroyed already'}`)
                }

                tmp.send(data.data);
                return Promise.resolve()
            }
            // 是否需要新建通道
            let channelId
            if (/(Blob|ArrayBuffer)/.test(data.channelType)) {
                return this.createChannel({ label: data.channelType }).then((channelId) => {
                    data.channelId = channelId
                    next();
                    return Promise.resolve(channelId)
                })
            }

            next();

            function next() {
                console.log('next', data)
                // 普通数据传递
                data = JSON.stringify(data)

                if (that.dataChannel.readyState !== 'open') return Promise.reject('dataChannel state error')
                that.dataChannel.send(data);
            }
            return Promise.resolve()

        }
        if (this.dataChannel.readyState !== 'open') return Promise.reject('dataChannel state error')
        console.log('normal', data)
        this.dataChannel.send(JSON.stringify(data));
        return Promise.resolve()
    },
    // 新建通道
    /**
     * 为了防止新建通道刚刚建立还未注册事件就发送数据，导致对端收不到数据，这里需要做个防抖，采用promise
     * 对外公开的API
     * option.label: 通道名字
     * option.channelStatus: 连接类型：long:长连接，数据发送完毕不会关闭, short(默认值): 短连接，数据发送完毕立即关闭销毁
     * option.channelType: 发送的数据类型，目前有ArrayBuffer / Blob(目前chrome还不支持该类型)，可选
     * option.type: 传输内容的类型，用于接收端解析，目前有文件，图片什么的
     * option.data: 里面包含该文件的具体信息，比如name / size等等
     */
    createChannel(option = {}) {
        if (!this.rtcConnection) return Promise.reject('no rtc connection')

        let { label, channelStatus = 'short' } = option

        if (!label) return Promise.reject('missing parameter: label')

        label = label + Date.now()
        // let name = label + Date.now()
        label = channelStatus + '-' + label
        let dataChannel = this.rtcConnection.createDataChannel(label, { ordered: true });
        this.rtcDataChannels[label] = dataChannel

        this.onDataChannel(dataChannel)
        console.log(`${this.getDate()} 建立通道: ${label} ---> ${dataChannel.id}`)
        return new Promise((resolve, reject) => {
            setTimeout(() => {
                resolve(label)
            }, 1000)
        })
        // .then((label) => {
        //     let sendData = {
        //         type: type,
        //         channelId: label,
        //         channelType: channelType,
        //         data: data
        //     }
        //     sendData = JSON.stringify(sendData)

        //     if (this.dataChannel.readyState !== 'open') return Promise.reject('dataChannel state error')
        //     this.dataChannel.send(sendData);
        //     return Promise.resolve(label)
        // })
    },
    /** 获取格式化日期接口 */
    getDate() {
        let now = new Date()
        now = now.toLocaleString()
        return now + ' ---- '
    },
    /**
     * dataChannel事件监听
     * 由于有可能有多个通道，这里需要传入需要注册事件的通道
     * 
     */
    onDataChannel(channel) {
        let that = this
        // console.log(`${that.getDate()} 通道事件注册:`, channel)
        channel.onopen = function () {
            logger.log(`${that.getDate()} ${channel.id} --> dataChannel opened, ready now`);
        };
        channel.onerror = function (error) {
            console.error(`${that.getDate()} ${channel.id} --> dataChannel error:`, error);
        };
        channel.onmessage = function (event) {

            let data = event.data

            if (data.constructor === String) data = JSON.parse(data)

            // 如果是短连接, 数据发送完毕后关闭通道
            if (!data && channel.label in that.rtcDataChannels && /^short-/.test(channel.label)) {
                that.closeChannel(channel)
                return
            }

            if (/(Blob|ArrayBuffer)/.test(data.constructor)) data = { channelId: channel.label, data }

            that.onRemoteData(data)

        };
        channel.onclose = function (data) {
            logger.warn(`${that.getDate()} ${channel.id} --> dataChannel closed now`);
            // 关闭自己端的通道
            that.closeChannel(channel)
        };
    },
    /**
     * 关闭通道
     * 由于有可能有多个通道，这里需要参数指定
     * 参数注解，channel可以为channelLabel，也可以是dataChannel实体
     */
    closeChannel(channel) {
        if (!channel) return
        if (channel.constructor !== RTCDataChannel) {
            channel = this.rtcDataChannels[channel]
        }
        if (!channel) return
        logger.warn(`${this.getDate()} 销毁通道: ${channel.label} --> ${channel.id}`)
        channel.close();
        channel.onopen = null
        channel.onerror = null
        channel.onmessage = null
        channel.onclose = null
        this.rtcDataChannels[channel.label] = null
    },
    /*****************以下是收发各种数据格式的API, API将成对出现**********************************/
    /** 
     * 真正发送数据的接口, 数据在发送前和接收后进行装载和卸载处理，处理后再回传给客户端
        option = {
            // 发送的数据类型
            type: RTC_DATA_TYPE,
            // 真正的自定义数据，接收端自己解析
            data,
            // 发送数据的通道，如果不传，默认使用初始化时开启的通道
            channel
        }
     */

    sendData(option = {}) {
        let { type, data, channel } = option
        if (!type || !data) return Promise.reject('sendData error: invalid parameter')
        if (!channel) channel = this.dataChannel

        if (!channel || channel.readyState !== 'open') {
            return Promise.reject(`${channel ? 'dataChannel state error:' + channel.readyState : 'dataChannel destroyed already'}`)
        }
        option = JSON.stringify(option)
        channel && channel.send(option);
        return Promise.resolve()
    },
    /** 接收远程数据 **/
    onRemoteData(result) {

        // console.log(`${this.getDate()} get remote data:`, result);

        // 纯字符串数据被丢弃，理论上不应该有这种格式的数据
        if (result.constructor !== Object) return

        let { type, channelId, data } = result

        let fn = type && RTC_DATA_TYPE_RV[type] && RTC_DATA_TYPE_FN[RTC_DATA_TYPE_RV[type]]

        // 五种数据发送规则类型的处理
        if (fn) {
            return this[fn] && this[fn]({ channelId: channelId, data: data })
        }

        // 特殊格式的数据接收
        if (channelId && data && data.constructor === ArrayBuffer) {
            return this.onBuffer(result)
        }

    },
    /** 接口，发送普通text */
    sendText(data) {
        data = { data: data }
        return this.sendData({ type: RTC_DATA_TYPE['text'], data })
    },
    /** 接收普通text */
    onText(data) {
        data = data.data.data
        this.emit('text', data)
    },
    /** 发送聊天内容 */
    sendMessage(data) {
        data = { data: data }
        return this.sendData({ type: RTC_DATA_TYPE['message'], data })
    },
    /** 接收聊天内容 */
    onMessage(data) {
        // console.log(data)
        data = data.data.data
        this.emit('message', data)
    },
    /** 
     * 发送通知
     * 一般用于通知对方即将开启通道发送Blob、ArrayBuffer
     * 发送通知前都会创建一个对应的dataChannel通道
     */
    sendNotify(data) {
        let that = this
        if (!data || !data.channelType) return Promise.reject('sendNotify error: invalid parameter data')
        if (/(Blob|ArrayBuffer)/.test(data.channelType)) {
            // 如果有channelId, 不再createChannel
            if (data.channelId) {
                next();
                return Promise.resolve(data.channelId)
            }

            return this.createChannel({ label: data.channelType }).then((channelId) => {
                data.channelId = channelId
                next();
                return Promise.resolve(channelId)
            })
        }

        function next() {
            console.log(`${that.getDate()} sendNotify:`, data)
            that.sendData({ type: RTC_DATA_TYPE['notify'], data })
        }
    },
    /** 接收通知，进行处理 */
    onNotify(result) {
        console.log(`${this.getDate()} onNotify:`, result)
        // 是否是接收特殊数据的通知
        let { channelId, data } = result
        let { type } = data

        // 初始化文件接收工作
        if (type && /(file|image|canvas|blob)/.test(type) && data.channelId) {
            let tmp = this.remoteTMP[data.channelId] = {}
            tmp.size = data.size
            tmp.currentSize = 0
            tmp.name = data.name
            tmp.type = type
            tmp.buffer = []
            return
        }

        // 普通通知，直接回传
        this.emit('notify', data)
    },
    /** 发送ArrayBuffer */
    sendBuffer(data) {
        if (!data || !data.constructor === Object) return Promise.reject('sendBuffer error: invalid data')
        if (data.data && /(Blob|ArrayBuffer)/.test(data.data.constructor)) {
            if (!data.channelId) return Promise.reject('no channelId')
            let tmp = this.rtcDataChannels[data.channelId]

            // console.log(`${this.getDate()} send ArrayBuffer`)

            if (!tmp || tmp.readyState !== 'open') {
                return Promise.reject(`${tmp ? 'dataChannel state error:' + tmp.readyState : 'dataChannel destroyed already'}`)
            }

            tmp.send(data.data);
            return Promise.resolve()
        }
    },
    /** 接收ArrayBuffer接口 */
    onBuffer(result = {}) {
        // console.log(result)

        let { channelId, data } = result
        if (!channelId || data.constructor !== ArrayBuffer) return

        let tmp = this.remoteTMP[channelId]
        // let {name, size, currentSize, buffer} = tmp

        tmp.buffer.push(data);
        tmp.currentSize += data.byteLength;

        if (tmp.currentSize === tmp.size) {
            // this.showReceivedFile(tmp)
            tmp.isDone = true
        }

        // 接收状态同步回传
        tmp.type === 'file' && this.emit('receiveFile', tmp)
        tmp.type === 'blob' && this.emit('receiveBlob', tmp)
        tmp.type === 'buffer' && this.emit('receiveBuffer', tmp)

        // 文件接收完毕，进行销毁工作
        if (tmp.isDone) {

            delete this.remoteTMP[channelId]

            // 如果是短连接, 数据发送完毕后关闭通道
            if (channelId in this.rtcDataChannels && /^short-/.test(channelId)) {
                this.closeChannel(channelId)
                return
            }
        }
    },
    /** 发送文件接口 */
    sendFile(file) {

        if (!file || file.constructor !== File) return Promise.reject('sendFile error: parameter invalid')
        if (!this.inited) return Promise.reject('sendFile error: no rtc connection')

        let that = this
        let size = file.size;
        let name = file.name;
        let chunkSize = 100000;
        // let chunkSize = 16384;
        let channelId = null;
        return this.sendNotify({
            type: 'file',
            channelType: 'ArrayBuffer',
            name,
            size,
            chunkSize
        }).then(cid => {

            if (!cid) return

            channelId = cid
            sliceFile(0);

            return Promise.resolve()
        })

        function sliceFile(offset) {
            var reader = new FileReader();
            reader.onload = (function () {
                return function (e) {
                    let data = e.target.result
                    let currentSize = offset + e.target.result.byteLength
                    that.sendBuffer({ channelId, data }).then(() => {

                        if (file.size > offset + e.target.result.byteLength) {
                            setTimeout(sliceFile, 0, offset + chunkSize);
                        }

                        // 发送状态同步回传
                        that.emit('sendFile', { name, size, currentSize })

                    }).catch(err => {
                        console.error(err)
                    })

                };
            })(file);
            var slice = file.slice(offset, offset + chunkSize);
            reader.readAsArrayBuffer(slice);
        };

    },
    /** 发送Blob数据接口
     * channelId 传输blob数据的通道id，必填
     * data 传输的blob数据，必填
     */
    sendBlob(channelId, blob) {
        if (!channelId) return Promise.reject('no channelId')
        if (!blob || blob.constructor !== Blob) return Promise.reject('sendBlob error: parameter invalid')
        if (!this.inited) return Promise.reject('sendBlob error: no rtc connection')

        let that = this
        let size = blob.size;
        let name = blob.name;
        let chunkSize = 100000;

        return this.sendNotify({
            type: 'blob',
            channelId,
            channelType: 'ArrayBuffer',
            name,
            size,
            chunkSize
        }).then(() => {

            sliceBlob(0);

            return Promise.resolve()
        })

        function sliceBlob(offset) {
            var reader = new FileReader();
            reader.onload = (function () {
                return function (e) {
                    let data = e.target.result
                    let currentSize = offset + e.target.result.byteLength
                    that.sendBuffer({ channelId, data }).then(() => {

                        if (blob.size > offset + e.target.result.byteLength) {
                            setTimeout(sliceBlob, 0, offset + chunkSize);
                        }
                        // 发送状态同步回传
                        that.emit('sliceBlob', { name, size, currentSize })

                    }).catch(err => {
                        console.error(err)
                    })
                };
            })(blob);
            var slice = blob.slice(offset, offset + chunkSize);
            reader.readAsArrayBuffer(slice);
        };
    }
}

// call(参数一个个传递) & apply(参数数组传递)
window.logger = {
    init() {
        this.loggerInfo = console.info
        this.loggerWarn = console.warn
        this.loggerError = console.error
        this.loggerLog = console.log
    },
    info() {
        let params = [...arguments]
        if (params.length === 0) return
        let style = 'color:blue;font-size:15px';
        params[0] = `%c${params[0]}`
        params.splice(1, 0, style)
        console.log.apply(this, params)
    },
    warn() {
        let params = [...arguments]
        if (params.length === 0) return
        let style = 'color:orange;font-size:15px';
        params[0] = `%c${params[0]}`
        params.splice(1, 0, style)
        console.log.apply(this, params)
        // console.warn('%ctest', 'color:orange;font-size:15px', 'aaaa')
    },
    error() {
        let params = [...arguments]
        if (params.length === 0) return
        let style = 'color:red;font-size:15px';
        params[0] = `%c${params[0]}`
        params.splice(1, 0, style)
        console.log.apply(this, params)
        // console.error('%ctest', 'color:red;font-size:15px', 'aaaa')
    },
    log() {
        let params = [...arguments]
        if (params.length === 0) return
        let style = 'color:green;font-size:15px';
        params[0] = `%c${params[0]}`
        params.splice(1, 0, style)
        console.log.apply(this, params)
        // this.loggerLog.call(this,arguments)
        // Function.prototype.apply.cal(console.log, console, arguments)
    }
}
logger.init()
/****************API对外暴露部分*************** */
window.rtcSDK = rtcSDK



/******************************SDK END************************************ */

/** 测试用 */
window.sdp = function (str) {
    if (!str) return
    var reg = /(v=|o=[^0-9]|s=-|t=0|a=|b=|c=I|m=|t=0)\w{0,1}/gi
    // var res = str.match(reg)
    var res = str.replace(reg, function (item) {
        return '<br>\r\n' + item
        // console.log(item)
    })
    // console.log(res)
    return res
}

