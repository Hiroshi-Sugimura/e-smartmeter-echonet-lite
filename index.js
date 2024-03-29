//////////////////////////////////////////////////////////////////////
//	Copyright (C) Hiroshi SUGIMURA 2021.09.13 - above.
//////////////////////////////////////////////////////////////////////
'use strict';

const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');


//////////////////////////////////////////////////////////////////////
// Electric Smart Meter

// RL7023Stick-D
let ESmartMeter = {
	deviceType: 'ROHM',  // WiSUNドングルのデバイスタイプ（TESSERA, ROHM）
	WiID: '',     // スマメのBルート認証ID設定（電力会社に申請，ユーザ設定）
	WiPASS: '',   // スマメのBルート認証パスワード設定（電力会社に申請，ユーザ設定）
	port : null,  // スマートメータと通信するシリアルポートオブジェクト
	state: 'disconnected',  // 状態管理
	debug: false,   // trueでデバッグモード
	portList: [],   // シリアルポートリスト
	facilities: {},	// 機器情報リスト
	EPANDESC: {},  // スマートメータとの通信情報
	IPv6: '',  // 送信先（スマートメータ）のIPを覚えておく
	userfunc: null,  // 受信データのユーザコールバック
	tid: [0,0],   // transaction id
	portConfig: {  // serial port config
		path: 'COM3',
		baudRate: 115200,
		dataBits: 8,
		stopBits: 1,
		parity: 'none' },
	connectedTimeoutID: null,  // connection成功のタイムアウト
	retryRemain: 3, // connectionのリトライ回数
	observationEPCs: [],   // 監視対象のEPCリスト
	observationTimerEnabled: false,  // timerでの監視フラグ
	observationTimerID: {},  // ID管理，Timeoutクラス
	observationDispersion: 30000  // 監視間隔の分散 (* 0..<1), 30s
};


//////////////////////////////////////////////////////////////////////
// シリアルポートのリスト取得
ESmartMeter.renewPortList = async function () {
	ESmartMeter.portList = [];

	await SerialPort.list()
		.then( (ports) => {
			ESmartMeter.portList = ports;
		}) .catch( (err) => {
			console.log(err, "e")
		});

	return ESmartMeter.portList;
};


// 受信強度計算
ESmartMeter.lqiAssess = function (lqi) {
	let LQI = parseInt(lqi, 17);
	let PdBm = (7*LQI-1970)/20;

	if( LQI < 50 ) {
		console.log('Bad condition. ', PdBm, 'dBm');
	}else if( LQI < 100) {
		console.log('Not good condition.', PdBm, 'dBm');
	}else if( LQI < 150) {
		console.log('Good condition.', PdBm, 'dBm');
	}else{
		console.log('Great condition.', PdBm, 'dBm');
	}
};




// 受信関数
ESmartMeter.onReceive = async function (data) {
	data = data.slice( 0, -2 ); // 受信データのCrLfを消す
	let recvData = await ESmartMeter.parseReceive(data);
	// console.dir( recvData );

	switch( ESmartMeter.state ) {
		case 'setSFE':   // SFE設定中
		if( data.toString('UTF-8') == 'OK' ) { // 設定OK
			ESmartMeter.state = 'setPassword';
			ESmartMeter.debug ? console.log('-- SM:setPassword (SKSETPWD C)', ESmartMeter.WiPASS):0;
			ESmartMeter.write('SKSETPWD C ' + ESmartMeter.WiPASS );  // set password
		}else{
			ESmartMeter.debug ? console.log('-- SM:setSFE, set echoback is disabled') : 0;
			ESmartMeter.write('SKSREG SFE 0' ); // echo back disable
		}
		break;

		case 'setPassword':  // パスワード設定中
		if( data.toString('UTF-8') == 'OK' ) {  // 設定OK
			ESmartMeter.state = 'setID';
			ESmartMeter.debug ? console.log('-- SM:setID (SKSETRBID)', ESmartMeter.WiID):0;
			ESmartMeter.write('SKSETRBID ' + ESmartMeter.WiID  );  // set id
		}else{
			ESmartMeter.debug ? console.log('-- SM:setPassword (SKSETPWD C)', ESmartMeter.WiPASS):0;
			ESmartMeter.write('SKSETPWD C ' + ESmartMeter.WiPASS );  // set password
		}
		break;

		case 'setID':  // ID設定中
		if( data.toString('UTF-8') == 'OK' ) {  // 設定OK
			if( ESmartMeter.EPANDESC && ESmartMeter.EPANDESC.channel ) { // すでにチャンネルをわかっていればscanしないのでsetChannelまで飛ぶ
				ESmartMeter.state = 'setChannel';
				ESmartMeter.debug ? console.log('-- SM:setChannel (SKREG S2)', ESmartMeter.EPANDESC.channel):0;
				ESmartMeter.write('SKSREG S2 ' + ESmartMeter.EPANDESC.channel ); // channel
			}else{
				ESmartMeter.state = 'scanning';	// active scan, takes about 10s
				ESmartMeter.debug ? console.log('-- SM:scanning (SKSCAN)'):0;
				if( ESmartMeter.deviceType == 'ROHM' ) {
					ESmartMeter.write('SKSCAN 2 FFFFFFFF 4 0'); // ROHMのコマンド
				}else{
					ESmartMeter.write('SKSCAN 2 FFFFFFFF 6'); // TESSERA, JORJINのコマンド
				}
				// scanもtimeoutつけたほうが良い
			}
		}else{
			ESmartMeter.debug ? console.log('-- SM:setID (SKSETRBID)', ESmartMeter.WiID):0;
			ESmartMeter.write('SKSETRBID ' + ESmartMeter.WiID  );  // set id
		}

		case 'scanning':  // スキャン中
		ESmartMeter.debug ? process.stdout.write('.'):0;
		if( data.toString('UTF-8') == 'OK' ) { break; }  // スキャンのOKは無視

		// scanning中はいくつかメッセージを受信する
		if( recvData.msgs ) {
			recvData.msgs.forEach( (msg) => {
				ESmartMeter.debug ? console.dir( msg ):0;
				if( msg.length >= 2 && msg[0]=='EVENT' && msg[1]=='20' ) {
					// EVENT 20はEPANDESC
					ESmartMeter.EPANDESC = ESmartMeter.getEPANDESC( data.toString('UTF-8') );  // スキャン成功
					if( ESmartMeter.debug && ESmartMeter.EPANDESC ) {
						console.dir( ESmartMeter.EPANDESC );
						ESmartMeter.EPANDESC.lqi ? ESmartMeter.lqiAssess( ESmartMeter.EPANDESC.lqi ):0;
					}

				}else if( msg.length >= 2 && msg[0]=='EVENT' && msg[1]=='22' ) {
					// EVENT 22はSCAN終了
					if( ESmartMeter.EPANDESC != null ) {
						ESmartMeter.state = 'setChannel';
						if( ESmartMeter.EPANDESC.channel ) { // たまにEPANDESCが取れているけどchannelが取れていないことがある
							ESmartMeter.debug ? console.log('-- SM:setChannel (SKREG S2)', ESmartMeter.EPANDESC.channel):0;
							ESmartMeter.write('SKSREG S2 ' + ESmartMeter.EPANDESC.channel ); // channel
						}else{
							ESmartMeter.debug ? console.log('-- SM:setChannel channel is null or undefined. re-scan.'):0;
							ESmartMeter.state = 'setID';
							ESmartMeter.debug ? console.log('-- SM:setID (SKSETRBID)', ESmartMeter.WiID):0;
							ESmartMeter.write('SKSETRBID ' + ESmartMeter.WiID  );  // set id
						}

					}else{
						ESmartMeter.debug ? console.log('-- SM:scanning (SKSCAN)'):0;
						if( ESmartMeter.deviceType == 'ROHM' ) {
							ESmartMeter.write('SKSCAN 2 FFFFFFFF 6 0'); // ROHMのコマンド
						}else{
							ESmartMeter.write('SKSCAN 2 FFFFFFFF 6'); // TESSERA, JORJINのコマンド，スキャン時間6秒
						}
					}
				}
			});
		}
		break;

		case 'setChannel': // チャンネル設定中
		if( data.toString('UTF-8') == 'OK' ) {  // 設定OK
			ESmartMeter.state = 'setPanID';
			ESmartMeter.debug ? console.log('-- SM:setPanID (SKREG S3)', ESmartMeter.EPANDESC.panID):0;
			ESmartMeter.write('SKSREG S3 ' + ESmartMeter.EPANDESC.panID ); // panID
		}else{
			ESmartMeter.debug ? console.log('-- SM:setChannel (SKREG S2)', ESmartMeter.EPANDESC.channel):0;
			ESmartMeter.write('SKSREG S2 ' + ESmartMeter.EPANDESC.channel ); // channel
		}
		break;

		case 'setPanID':  // Pan ID設定中
		if( data.toString('UTF-8') == 'OK' ) {  // 設定OK
			ESmartMeter.state = 'getIPv6';
			ESmartMeter.debug ? console.log('-- SM:getIPv6, mac addr (SKLL64)', ESmartMeter.EPANDESC.address):0;
			ESmartMeter.write('SKLL64 ' + ESmartMeter.EPANDESC.address ); // mac address to IPv6
		}else{
			ESmartMeter.debug ? console.log('-- SM:setPanID (SKREG S3)', ESmartMeter.EPANDESC.panID):0;
			ESmartMeter.write('SKSREG S3 ' + ESmartMeter.EPANDESC.panID ); // panID
		}
		break;

		case 'getIPv6':  // IPv6取得
		ESmartMeter.IPv6 = ESmartMeter.getIPv6( data.toString('UTF-8') ); // 取得できた
		if( ESmartMeter.IPv6 != null ) {
			ESmartMeter.state = 'setIPv6';
			ESmartMeter.debug ? console.log('-- SM:setIPv6 (SKJOIN)', ESmartMeter.IPv6 ):0;
			ESmartMeter.write('SKJOIN ' + ESmartMeter.IPv6 ); // set IPv6
		}else{
			ESmartMeter.debug ? console.log('-- SM:getIPv6, mac addr (SKLL64)', ESmartMeter.EPANDESC.address):0;
			ESmartMeter.write('SKLL64 ' + ESmartMeter.EPANDESC.address ); // mac address to IPv6
		}
		break;

		case 'setIPv6':  // IPv6設定中
		if( data.toString('UTF-8') == 'OK' ) {  // 設定OK
			ESmartMeter.state = 'connecting';
			ESmartMeter.debug ? console.log('-- SM:connecting' ):0;
		}else{  // 設定うまくいかなかったら取得からもう一度
			ESmartMeter.debug ? console.log('-- SM:setIPv6 (SKJOIN)', ESmartMeter.IPv6 ):0;
			ESmartMeter.write('SKJOIN ' + ESmartMeter.IPv6 ); // set IPv6
		}
		break;

		case 'connecting':  // 接続した，EVENT 24なら失敗，EVENT 25なら接続完了
		ESmartMeter.debug ? process.stdout.write('.'):0;

		// うまく発見するのは相当難しい
		// 結局，connectingの後でEVENT 25が来るか，3分まってリトライする
		if( ESmartMeter.connectedTimeoutID == null ) {
			ESmartMeter.debug ? console.log(' SM:setConnectedTimeout'):0;
			ESmartMeter.connectedTimeoutID = setTimeout( () => {
				ESmartMeter.debug ? console.log('-- SM:clearConnectedTimeout'):0;
				ESmartMeter.debug ? console.log('-- SM:connecting EVENT not found (timeout) and retry.'):0;
				ESmartMeter.state = 'connecting-retry';
				ESmartMeter.debug ? console.log('-- SM:retry (SKINFO)' ):0;
				ESmartMeter.write('SKINFO' ); // リトライ＋情報取得
			}, 2 * 60 * 1000);
		}

		if( recvData.msgs ) {
			recvData.msgs.forEach( (msg) => {
				if( msg.length >= 2 && msg[0]=='EVENT' && msg[1]=='25' ) {
					// EVENT 25は成功
					ESmartMeter.debug ? console.log('-- SM:connecting available (EVENT 25)'):0;
					ESmartMeter.state = 'available';
					if( ESmartMeter.connectedTimeoutID ) {
						ESmartMeter.debug ? console.log('-- SM:clearConnectedTimeout'):0;
						clearTimeout(ESmartMeter.connectedTimeoutID);
						ESmartMeter.connectedTimeoutID = null;
					}
					ESmartMeter.userfunc( { state:'available', data:recvData}, null, null, null );

				}else if( msg.length >= 2 && msg[0]=='EVENT' && msg[1]=='24' ) {
					// EVENT 24は失敗
					ESmartMeter.debug ? console.log(' SM:connecting failed (EVENT 24)'):0;
					ESmartMeter.state = 'connecting-retry';
					if( ESmartMeter.connectedTimeoutID ) {
						ESmartMeter.debug ? console.log('-- SM:clearConnectedTimeout'):0;
						clearTimeout(ESmartMeter.connectedTimeoutID);
						ESmartMeter.connectedTimeoutID = null;
					}
					ESmartMeter.debug ? console.log('-- SM:retry (SKINFO)' ):0;
					ESmartMeter.write('SKINFO' ); // リトライトリガー＋情報取得
				}
			});
		}
		break;

		case 'connecting-retry':  // リトライ処理
		ESmartMeter.debug ? console.log('-- SM:connecting-retry remain:', ESmartMeter.retryRemain):0;
		if( !ESmartMeter.retryRemain ) {
			ESmartMeter.retryRemain = 3;
			ESmartMeter.state = 'failed';
			// 失敗したときの状態を確認
			// ESmartMeter.write('SKSREG S2' ); // channel
			// ESmartMeter.write('SKSREG S3' ); // panID
			ESmartMeter.release();
			ESmartMeter.userfunc( { state:'failed', data:recvData}, null, null, 'Error: The maximum number of retries has been reached.' );
		}else{
			ESmartMeter.retryRemain -= 1;
			ESmartMeter.state = 'connecting';
			ESmartMeter.debug ? console.log('-- SM:retry (SKJOIN) ', ESmartMeter.IPv6 ):0;
			ESmartMeter.write('SKJOIN ' + ESmartMeter.IPv6 ); // set IPv6
		}
		break;

		case 'available':  // 手続き終了，利用可能
		if( recvData.count == 0 ) { break; } // 受信データなしの時は無視
		if( recvData.count == 1 && recvData.msgs[0][0] == 'OK' ) { break; } // OKのみの時は無視

		try{
			ESmartMeter.returner( { state:'available', data:recvData, raw:data }, ESmartMeter.userfunc );
		}catch(e){
			ESmartMeter.userfunc( { state:'error', data:null}, null, null, e );
		}
		break;

		default:
	}
	await ESmartMeter.sleep( 1000 );  // 1s
};

// ポートオープンしたら
ESmartMeter.onOpen = function ( err ) {
	if (err) {
		ESmartMeter.debug ? console.log('-- SM:portOpen port is error. err:', err ):0;
		return;
	}

	ESmartMeter.debug ? console.log('-- SM:portOpen port is ok.', ESmartMeter.portConfig.path ):0;

	// ここからスマメ接続シーケンス，ポート雄分をトリガーにして，受信ベースで状態遷移していく
	ESmartMeter.state = 'setSFE';
	ESmartMeter.debug ? console.log('-- SM:setSFE, set echoback is disabled') : 0;
	ESmartMeter.write('SKSREG SFE 0' ); // echo back disable
};

ESmartMeter.onClose = function () {
	ESmartMeter.debug ? console.log('-- SM:close') : 0;
	ESmartMeter.release();
};

//////////////////////////////////////////////////////////////////////
// このモジュールの初期化
// id = Bルート認証ID設定
// password = Bルート認証パスワード設定
ESmartMeter.initialize = async function( config, callback ) {
	ESmartMeter.debug = config.debug ? config.debug : false;
	ESmartMeter.debug ? console.log( '-- SM:ESmartMeter.initialize.' ):0;

	if( ESmartMeter.port && ESmartMeter.state == 'available' ) {  // すでに通信している
		ESmartMeter.debug ? console.error( `-- SM:initialize: port is used already. state: ${ESmartMeter.state}` ):0;
		ESmartMeter.debug ?ESmartMeter.userfunc( ESmartMeter, null, null, 'Error: ESM is available already.' ):0;
		return;
	}

	if( ESmartMeter.port ) {  // すでに通信している
		ESmartMeter.debug ? console.error( `-- SM:initialize: port is used already. state: ${ESmartMeter.state}` ):0;
		ESmartMeter.userfunc( ESmartMeter, null, null, `Error: port is used already. state: ${ESmartMeter.state}` );
		return;
	}

	ESmartMeter.port = null;
	ESmartMeter.deviceType  = config.dongleType ? config.dongleType : 'TESSERA';
	ESmartMeter.WiID = config.id;
	ESmartMeter.WiPASS = config.password;

	ESmartMeter.state = 'disconnected';
	ESmartMeter.IPv6 = '';
	ESmartMeter.EPANDESC = config.EPANDESC ? config.EPANDESC : {};
	ESmartMeter.tid  = [0,0];
	ESmartMeter.userfunc = callback;
	ESmartMeter.connectedTimeoutID = null;
	ESmartMeter.retryRemain = 3;
	ESmartMeter.observationEPCs = config.observationEPCs ? config.observationEPCs : [];
	ESmartMeter.observationTimerEnabled = false;
	ESmartMeter.observationTimerID = {};  // ID管理，Timeoutクラス
	ESmartMeter.observationDispersion = 30000;

	await ESmartMeter.renewPortList();  // シリアルポートリスト更新
	ESmartMeter.debug ? console.log('-- SM:PortList:', ESmartMeter.portList ):0;
	ESmartMeter.debug ? console.log('-- SM:deviceType:', ESmartMeter.deviceType):0;
	ESmartMeter.debug ? console.log('-- SM:WiID:', ESmartMeter.WiID):0;
	ESmartMeter.debug ? console.log('-- SM:WiPASS:', ESmartMeter.WiPASS):0;


	// 環境センサーに接続
	// ユーザーにシリアルポート選択画面を表示して選択を待ち受ける
	let comList = await ESmartMeter.portList.filter( (p) => {
		if( p.vendorId == '0403' && p.productId == '6015') { // OMRON or TESSERA
			return p;
		}else if( p.vendorId == '0403' && p.productId == '6001') { // JORJIN
			ESmartMeter.deviceType = 'JORJIN';
			return p;
		}
	});

	if( comList.length == 0 ) {  // ドングル見つからない
		ESmartMeter.userfunc( null,null,null, 'Error: dongle is not found.' );
		return;
	}

	ESmartMeter.portConfig.path = comList[0].path;  // ドングル見つかった


	// ポートの設定と通信開始
	ESmartMeter.state = 'portOpen';
	ESmartMeter.debug ? console.log('-- SM:portOpen try', ESmartMeter.portConfig.path ):0;

	ESmartMeter.port = new SerialPort( ESmartMeter.portConfig );	// 接続
	ESmartMeter.port.pipe( new ReadlineParser({ delimiter: '\r\n' }) );	// データを行にする
	ESmartMeter.port.on('open',  ESmartMeter.onOpen ); 	// シリアルポートが準備できたらやる関数登録
	ESmartMeter.port.on('data',  ESmartMeter.onReceive ); 	// 受信関数登録
	ESmartMeter.port.on('close', ESmartMeter.onClose );	// close確認
};


ESmartMeter.release = function() {
	ESmartMeter.state = 'close';

	if( ESmartMeter.port != null ) {
		if( ESmartMeter.port.isOpen ) {
			ESmartMeter.debug ? console.log('-- SM:port isOpen now. port close' ):0;
			ESmartMeter.port.close( (error) => {
				if( error ) {
					console.error('-- SM:release() port.close error:', error);
				}
			});
		}
		ESmartMeter.port = null;
	}
	ESmartMeter.stopObservation();

	ESmartMeter.state = 'disconnected';
};


// スマートメータのチャンネルスキャンの情報を解析する
ESmartMeter.getEPANDESC = function ( str ) {
	let ret = {};
	let s = str.split( String.fromCharCode(13,10) );
	s = s.map( function (d) {
		return d.replace( /^[ ]*/, '' );
	} );

	let i = -1;
	if( i = s.indexOf( 'EPANDESC' ) == -1 ) {
		return null;
	}

	s.forEach( function(row) {
		row = row.split(':');

		switch( row[0] ) {
			case 'Channel':
			ret.channel = row[1];
			break;
			case 'Channel Page':
			ret.channelPage = row[1];
			break;
			case 'Pan ID':
			ret.panID = row[1];
			break;
			case 'Addr':
			ret.address = row[1];
			break;
			case 'LQI':
			ret.lqi = row[1];
			break;
			case 'PairID':
			ret.pairID = row[1];
			break;
		}
	});

	// ESmartMeter.debug ? console.dir( ret ) : 0;
	return ret;
};



//////////////////////////////////////////////////////////////////////
// 変換系
//////////////////////////////////////////////////////////////////////

// OK，EVENT，ERXUDPとあるっぽい，serial通信のストリーム処理の細かいことを考えると相当難しい
// 受信データを解析する
ESmartMeter.parseReceive = function(streamData) {
	// console.log( '-- SM:parseReceive()', streamData.toString('UTF-8') );
	let m = streamData.toString('UTF-8').replace( /\r?\n/g, ' ' );
	m = m.replace( /[ ]+/g, ' ' );
	let array = m.split( ' ' );


	// empty itemsがくるときがあるのでフィルタで消す
	let arr = array.filter(function (e) {
		return e != null;
	});

	let ret = {count:0, msgs:[] };
	let msg = [];
	let msgIdx = 0;
	for( let i=0; i<arr.length; i+=1 ) {
		switch( arr[i] ) {
			case 'OK':
			case 'EVENT':
			case 'ERXUDP':
			case 'EEDSCAN':
			if( msgIdx != 0 ) { // msgがあれば登録 sliceに引数なしでdeep copy
				ret.msgs.push( msg.slice() );
				msgIdx = 0;
				msg = [];
			}
			ret.count += 1;
			msg[0] = arr[i];
			msgIdx += 1;
			break;

			default:
			if( ret.count != 0 ) {  // OK, EVENT,ERXUDPが来る前のごみは無視
				msg[msgIdx] = arr[i];
				msgIdx += 1;
			}
			break;
		}
	}
	// 終了フラグとかないので
	if( msgIdx != 0 ) { ret.msgs.push( msg.slice() ); } // msgがあれば登録 sliceに引数なしでdeep copy

	return ret;
};

// バイトデータをいれるとELDATA形式にする
ESmartMeter.parseBytes = function (bytes) {
	try {
		// 最低限のELパケットになってない
		if (bytes.length < 14) {
			console.error("## EL.parseBytes error. bytes is less then 14 bytes. bytes.length is " + bytes.length);
			console.error(bytes);
			return null;
		}

		// 数値だったら文字列にして
		let str = "";
		if (bytes[0] != 'string') {
			for (let i = 0; i < bytes.length; i++) {
				str += ESmartMeter.toHexString(bytes[i]);
			}
		}
		// 文字列にしたので，parseStringで何とかする
		return (ESmartMeter.parseString(str));
	} catch (e) {
		throw e;
	}
};


// 16進数で表現された文字列をいれるとELDATA形式にする
ESmartMeter.parseString = function (str) {
	let eldata = {};

	// 28文字以上（14Bytes）ないとELとして成立しない
	// 全体が偶数文字じゃないとおかしい
	if( str.length < 28 || str.length % 2 ) {
		console.error( 'Error: ESmartMeter.parseString() str.length:', str.length, ', str:', str );
		return null;
	}

	if( str.substr(0, 4) != '1081' && str.substr(0, 4) != '1082' ) {  // eldata形式のヘッダ？
		// console.error(str.substr(0, 4));
		return null;
	}

	if( str.substr(0, 4) == '1082' ) {  // 任意電文形式, arbitrary message formatは解析しない
		eldata = {
			'EHD': str.substr(0, 4),
			'AMF': str.substr(4)
		}
		return (eldata);
	}

	try {
		eldata = {
			'EHD': str.substr(0, 4),
			'TID': str.substr(4, 4),
			'SEOJ': str.substr(8, 6),
			'DEOJ': str.substr(14, 6),
			'EDATA': str.substr(20),    // 下記はEDATAの詳細
			'ESV': str.substr(20, 2),
			'OPC': str.substr(22, 2),
			'DETAIL': str.substr(24),
			'DETAILs': ESmartMeter.parseDetail(str.substr(22, 2), str.substr(24))
		};
	} catch (e) {
		console.error(str);
		throw e;
	}

	return (eldata);
};


// 文字列をいれるとELらしい切り方のStringを得る
ESmartMeter.getSeparatedString_String = function (str) {
	try {
		if (typeof str == 'string') {
			return (str.substr(0, 4) + " " +
					str.substr(4, 4) + " " +
					str.substr(8, 6) + " " +
					str.substr(14, 6) + " " +
					str.substr(20, 2) + " " +
					str.substr(22));
		} else {
			// console.error( "str is not string." );
			throw new Error("str is not string.");
		}
	} catch (e) {
		throw e;
	}
};


// ELDATAをいれるとELらしい切り方のStringを得る
ESmartMeter.getSeparatedString_ELDATA = function (eldata) {
	return (eldata.EHD + ' ' + eldata.TID + ' ' + eldata.SEOJ + ' ' + eldata.DEOJ + ' ' + eldata.EDATA);
};

// ELDATA形式から配列へ
ESmartMeter.ELDATA2Array = function (eldata) {
	let ret = ESmartMeter.toHexArray(eldata.EHD + eldata.TID + eldata.SEOJ + eldata.DEOJ + eldata.EDATA);
	return ret;
};


// 16進表現の文字列を数値のバイト配列へ
ESmartMeter.toHexArray = function (string) {
	let ret = [];

	for (let i = 0; i < string.length; i += 2) {
		let l = string.substr(i, 1);
		let r = string.substr(i + 1, 1);
		ret.push((parseInt(l, 16) * 16) + parseInt(r, 16));
	}

	return ret;
};

// バイト配列を文字列にかえる
ESmartMeter.bytesToString = function (bytes) {
	let ret = "";

	for (let i = 0; i < bytes.length; i++) {
		ret += ESmartMeter.toHexString(bytes[i]);
	}
	return ret;
};

// 1バイトを文字列の16進表現へ（1Byteは必ず2文字にする）
ESmartMeter.toHexString = function (byte) {
	// 文字列0をつなげて，後ろから2文字分スライスする
	return (("0" + byte.toString(16)).slice(-2));
};

// Detailだけをparseする，内部で主に使う
ESmartMeter.parseDetail = function( opc, str ) {
	let ret = {}; // 戻り値用，連想配列
	str = str.toUpperCase();

	try {
		let array = ESmartMeter.toHexArray( str );  // edts
		let epc = array[0]; // 最初は0
		let pdc = array[1]; // 最初は1
		let now = 0;  // 入力データの現在処理位置, Index
		let edt = [];  // 各edtをここに集めて，retに集約

		// property mapのformat 2だけちょっと複雑なので別処理
		if( epc == 0x9d || epc == 0x9e || epc == 0x9f ) {
			if( pdc >= 17) { // プロパティの数が16以上の場合（プロパティカウンタ含めてPDC17以上）は format 2
				// 0byte=epc, 2byte=pdc, 4byte=edt
				ret[ ESmartMeter.toHexString(epc) ] = ESmartMeter.bytesToString( ESmartMeter.parseMapForm2( str.substr(4) ) );
				return ret;
			}
			// format 2でなければ以下と同じ形式で解析可能
		}

		// それ以外はEDT[0] == byte数
		// OPCループ
		for (let i = 0; i < opc; i += 1) {
			epc = array[now];  // EPC = 機能
			edt = []; // EDT = データのバイト数
			now++;

			// PDC（EDTのバイト数）
			pdc = array[now];
			now++;

			// getの時は pdcが0なのでなにもしない，0でなければ値が入っている
			if (pdc == 0) {
				ret[ESmartMeter.toHexString(epc)] = "";
			} else {
				// PDCループ
				for (let j = 0; j < pdc; j += 1) {
					// 登録
					edt.push(array[now]);
					now++;
				}
				ret[ESmartMeter.toHexString(epc)] = ESmartMeter.bytesToString(edt);
			}

		}  // opcループ

	} catch (e) {
		throw new Error('ESmartMeter.parseDetail(): detail error. opc: ' + opc + ' str: ' + str);
		return {};
	}

	return ret;
};

// parse Propaty Map Form 2
// 16以上のプロパティ数の時，記述形式2，出力はForm1にすること, bitstr = EDT
ESmartMeter.parseMapForm2 = function (bitstr) {
	let ret = [];
	let val = 0x80;
	let array = ESmartMeter.toHexArray(bitstr);

	// bit loop
	for (let bit = 0; bit < 8; bit += 1) {
		// byte loop
		for (let byt = 1; byt < 17; byt += 1) {
			if ((array[byt] >> bit) & 0x01) {
				ret.push(val);
			}
			val += 1;
		}
	}

	ret.unshift(ret.length);
	return ret;
};


// available以降，受信データの解析
/* 受信データ例
[
  'ERXUDP',
  'FE80:0000:0000:0000:021C:6400:03EF:EDFD',
  'FF02:0000:0000:0000:0000:0000:0000:0001',
  '0E1A',
  '0E1A',
  '001C640003EFEDFD',
  '1',
  '0012',
  '108100000EF0010EF0017301D50401028801'
]
*/
ESmartMeter.returner = function(sm, callback) {
	// ESmartMeter.debug ? console.log('-- SM:returner()') : 0;
	// ESmartMeter.debug ? console.log( JSON.stringify(sm) ) : 0;

	if( sm.data.count == 0 ) {
		// console.log( 'sm.data.count is 0, ignore.' );
		return;
	}

	try {
		sm.data.msgs.forEach( (msg) => {
			let els = {};
			let rinfo = {};

			if( ESmartMeter.deviceType == 'ROHM' ) {
				if( msg.length != 10 || msg[0] != 'ERXUDP' ) {
					// console.log( 'not echonet-lite serial data, ignore.' );
					return;
				}
				rinfo.address = msg[1];
				rinfo.port    = msg[3];

				els = ESmartMeter.parseBytes( sm.raw.slice(123) );  // 123Byte目からECHONET Lite frame
				if( !els ) {
					// console.log( '-- SM.returner() not echonet-lite:', sm.raw.slice(123) );
					return;
				}

				// 受信状態から機器情報修正, GETとINFREQ，SET_RESは除く
				if (els.ESV != "62" && els.ESV != "63" && els.ESV != '71') {
					ESmartMeter.renewFacilities(rinfo.address, els);
				}

			}else{  // TESSERA
				if( msg.length != 9 || msg[0] != 'ERXUDP' ) {
					// console.log( 'not echonet-lite serial data, ignore.' );
					return;
				}
				rinfo.address = msg[1];
				rinfo.port    = msg[3];

				if( ESmartMeter.deviceType == 'ROHM') {
					console.dir( msg[8] );
				}

				els = ESmartMeter.parseString( msg[8] );
				if( !els ) {
					// console.log( 'not echonet-lite, ignore.', msg );
					return;
				}

				// 受信状態から機器情報修正, GETとINFREQ，SET_RESは除く
				if (els.ESV != "62" && els.ESV != "63" && els.ESV != '71') {
					ESmartMeter.renewFacilities(rinfo.address, els);
				}
			}

			callback( sm, rinfo, els, null );
		});

	} catch (e) {
		console.error(e);
		throw e;
	}
};


ESmartMeter.getIPv6 = function( str ) {
	let ret = str.split( String.fromCharCode(13,10) )[0];
	// ESmartMeter.debug ? console.dir( ret ) : 0;
	return ret;
};



//////////////////////////////////////////////////////////////////////
// 送信
//////////////////////////////////////////////////////////////////////

// シリアル通知，送信のベース
ESmartMeter.write = function ( str ) {
	ESmartMeter.port.write( str + String.fromCharCode(13,10), function(err) {
		if (err) {
			console.error('-- SM(E):ESmartMeter.write() ', err.message);
			return err;
		}else{
			// console.log('-- SM:write, ok');
		}
	});
};


// EL送信のベース(ROHM)、本当はキューにしておきたい
ESmartMeter.sendBaseR = function (ip, buffer) {
	// console.log( '-- SM:sendBase' );
	let tid = [ buffer[2], buffer[3] ];
	let len = ('00' + ESmartMeter.toHexString(buffer.length)).slice(-4).toUpperCase();

	let d = new Buffer("SKSENDTO 1 " + ip + " 0E1A 1 0 " + len + " ");
	d = Buffer.concat([d, buffer, new Buffer([13, 10]) ]);  // CrLfを付与
	// console.dir( d );

	ESmartMeter.port.write( d, function(err) {
		if (err) {
			console.error('-- SM(E):ESmartMeter.sendBase()', err.message);
			return err;
		}else{
			// console.log('-- SM:sendBase, ok');
		}
	});

	return tid;
};

// EL送信のベース(TESSERA)、本当はキューにしておきたい
ESmartMeter.sendBaseT = function (ip, buffer) {
	// console.log( '-- SM:sendBase' );
	let tid = [ buffer[2], buffer[3] ];
	let len = ('00' + ESmartMeter.toHexString(buffer.length)).slice(-4).toUpperCase();

	let d = new Buffer("SKSENDTO 1 " + ip + " 0E1A 1 " + len + " ");
	d = Buffer.concat([d, buffer, new Buffer([13, 10]) ]);  // CrLfを付与
	// console.dir( d );

	ESmartMeter.port.write( d, function(err) {
		if (err) {
			console.error('-- SM(E):ESmartMeter.sendBase()', err.message);
			return err;
		}else{
			// console.log('-- SM:sendBase, ok');
		}
	});

	return tid;
};


// EL送信の基本的なAPI，大体これを使ったらよい
ESmartMeter.sendOPC1 = function (ipv6, seoj, deoj, esv, epc, edt) {
	ESmartMeter.debug ? console.log( '-- SM:sendOPC1()', seoj, deoj, esv, epc, edt) : 0;

	// TIDの調整
	let carry = 0; // 繰り上がり
	if( ESmartMeter.tid[1] == 0xff ) {
		ESmartMeter.tid[1] = 0;
		carry = 1;
	} else {
		ESmartMeter.tid[1] += 1;
	}
	if( carry == 1 ) {
		if( ESmartMeter.tid[0] == 0xff ) {
			ESmartMeter.tid[0] = 0;
		} else {
			ESmartMeter.tid[0] += 1;
		}
	}

	if (typeof (seoj) == "string") {
		seoj = ESmartMeter.toHexArray(seoj);
	}

	if (typeof (deoj) == "string") {
		deoj = ESmartMeter.toHexArray(deoj);
	}

	if (typeof (esv) == "string") {
		esv = (ESmartMeter.toHexArray(esv))[0];
	}

	if (typeof (epc) == "string") {
		epc = (ESmartMeter.toHexArray(epc))[0]
	}

	if (typeof (edt) == "number") {
		edt = [edt];
	} else if (typeof (edt) == "string") {
		edt = ESmartMeter.toHexArray(edt);
	}

	let buffer;

	if (esv == 0x62) { // get
		buffer = Buffer.from([
			0x10, 0x81,
			ESmartMeter.tid[0], ESmartMeter.tid[1],
			seoj[0], seoj[1], seoj[2],
			deoj[0], deoj[1], deoj[2],
			esv,
			0x01,
			epc,
			0x00]);
	} else {
		buffer = Buffer.from([
			0x10, 0x81,
			ESmartMeter.tid[0], ESmartMeter.tid[1],
			seoj[0], seoj[1], seoj[2],
			deoj[0], deoj[1], deoj[2],
			esv,
			0x01,
			epc,
			edt.length].concat(edt));
	}

	// データができたので送信する
	// console.dir( buffer );
	if( ESmartMeter.deviceType == 'ROHM' ) {
		return ESmartMeter.sendBaseR(ipv6, buffer);
	}else{
		return ESmartMeter.sendBaseT(ipv6, buffer);
	}
};

ESmartMeter.getE7 = function() {
	ESmartMeter.debug ? console.log('-- SM:getE7'):0;
	return ESmartMeter.sendOPC1(ESmartMeter.IPv6, '05FF01', '028801', '62', 'E7', '00');
};

ESmartMeter.getEA = function() {
	ESmartMeter.debug ? console.log('-- SM:getEA'):0;
	return ESmartMeter.sendOPC1(ESmartMeter.IPv6, '05FF01', '028801', '62', 'EA', '00');
};

ESmartMeter.getEB = function() {
	ESmartMeter.debug ? console.log('-- SM:getEB'):0;
	return ESmartMeter.sendOPC1(ESmartMeter.IPv6, '05FF01', '028801', '62', 'EB', '00');
};

ESmartMeter.get9F = function() {
	ESmartMeter.debug ? console.log('-- SM:get9F'):0;
	return ESmartMeter.sendOPC1(ESmartMeter.IPv6, '05FF01', '028801', '62', '9F', '00');
};


// メーターのプロファイルオブジェクトの設定を取得
ESmartMeter.getStaticProfObj = function() {
	ESmartMeter.debug ? console.log('-- SM:getStaticProfObj'):0;

	// TIDの調整
	let carry = 0; // 繰り上がり
	if( ESmartMeter.tid[1] == 0xff ) {
		ESmartMeter.tid[1] = 0;
		carry = 1;
	} else {
		ESmartMeter.tid[1] += 1;
	}
	if( carry == 1 ) {
		if( ESmartMeter.tid[0] == 0xff ) {
			ESmartMeter.tid[0] = 0;
		} else {
			ESmartMeter.tid[0] += 1;
		}
	}

	// 全静的プロパティゲット
	let buffer = Buffer.from([
		0x10, 0x81,
		ESmartMeter.tid[0], ESmartMeter.tid[1],
		0x05, 0xFF, 0x01,
		0x0E, 0xF0, 0x01,
		0x62,
		0x06,
		0x82, 0x00,  // Version情報
		0x8A, 0x00,  // メーカコード
		0xD3, 0x00,  // 自ノードインスタンス数
		0xD4, 0x00,  // 自ノードクラス数
		0xD5, 0x00,  // インスタンスリスト通知
		0xD6, 0x00   // 自ノードインスタンスリストS
		]);

	// データができたので送信する
	// console.dir( buffer );
	if( ESmartMeter.deviceType == 'ROHM' ) {
		return ESmartMeter.sendBaseR(ESmartMeter.IPv6, buffer);
	}else{
		return ESmartMeter.sendBaseT(ESmartMeter.IPv6, buffer);
	}
};


// メーターオブジェクトの設定、とくに静的なEPCを取得
ESmartMeter.getStaticMeterObj = function() {
	ESmartMeter.debug ? console.log('-- SM:getStaticMeterObj'):0;

	// TIDの調整
	let carry = 0; // 繰り上がり
	if( ESmartMeter.tid[1] == 0xff ) {
		ESmartMeter.tid[1] = 0;
		carry = 1;
	} else {
		ESmartMeter.tid[1] += 1;
	}
	if( carry == 1 ) {
		if( ESmartMeter.tid[0] == 0xff ) {
			ESmartMeter.tid[0] = 0;
		} else {
			ESmartMeter.tid[0] += 1;
		}
	}

	// 全静的プロパティゲット
	let buffer = Buffer.from([
		0x10, 0x81,
		ESmartMeter.tid[0], ESmartMeter.tid[1],
		0x05, 0xFF, 0x01,
		0x02, 0x88, 0x01,
		0x62,
		0x06,
		0x81, 0x00,  // 設置場所
		0x82, 0x00,  // 規格Version情報
		0x8A, 0x00,  // メーカコード
		0xD3, 0x00,  // 係数
		0xD7, 0x00,  // 積算電力量有効桁数
		0xE1, 0x00   // 積算電力量単位
		]);

	// データができたので送信する
	// console.dir( buffer );
	if( ESmartMeter.deviceType == 'ROHM' ) {
		return ESmartMeter.sendBaseR(ESmartMeter.IPv6, buffer);
	}else{
		return ESmartMeter.sendBaseT(ESmartMeter.IPv6, buffer);
	}
};


// メーターの消費電力関連を取得
// D3(係数), D7(積算電力量有効桁数), E1(積算電力量単位)は一緒にとっておいたほうが良い
// D3がない時は1
ESmartMeter.getMeasuredValues = function() {
	ESmartMeter.debug ? console.log('-- SM:getMeasuredValues'):0;

	// TIDの調整
	let carry = 0; // 繰り上がり
	if( ESmartMeter.tid[1] == 0xff ) {
		ESmartMeter.tid[1] = 0;
		carry = 1;
	} else {
		ESmartMeter.tid[1] += 1;
	}
	if( carry == 1 ) {
		if( ESmartMeter.tid[0] == 0xff ) {
			ESmartMeter.tid[0] = 0;
		} else {
			ESmartMeter.tid[0] += 1;
		}
	}

	// 全静的プロパティゲット
	let buffer = Buffer.from([
		0x10, 0x81,
		ESmartMeter.tid[0], ESmartMeter.tid[1],
		0x05, 0xFF, 0x01,
		0x02, 0x88, 0x01,
		0x62,
		0x06,
		0xE0, 0x00,  // 積算電力量計測値（正方向）
		0xE3, 0x00,  // 積算電力量計測値（逆方向）
		0xE7, 0x00,  // 瞬時電力計測値
		0xE8, 0x00,  // 瞬時電流計測値
		0xEA, 0x00,  // 定時積算電力量計測値（正方向）
		0xEB, 0x00   // 定時積算電力量計測値（逆方向）
		]);

	// データができたので送信する
	// console.dir( buffer );
	if( ESmartMeter.deviceType == 'ROHM' ) {
		return ESmartMeter.sendBaseR(ESmartMeter.IPv6, buffer);
	}else{
		return ESmartMeter.sendBaseT(ESmartMeter.IPv6, buffer);
	}
};



ESmartMeter.getStatic = async function () {
	ESmartMeter.debug ? console.log('-- SM:getStatic'):0;

	ESmartMeter.getStaticProfObj();
	await ESmartMeter.sleep( 10000 );  // 10s
	ESmartMeter.getStaticMeterObj();
};


//////////////////////////////////////////////////////////////////////
// 監理
//////////////////////////////////////////////////////////////////////

// ネットワーク内のEL機器全体情報を更新する，受信したら勝手に実行される
ESmartMeter.renewFacilities = function (ip, els) {
	let epcList;
	try {
		epcList = ESmartMeter.parseDetail(els.OPC, els.DETAIL);

		// 新規IP
		if (ESmartMeter.facilities[ip] == null) { //見つからない
			ESmartMeter.facilities[ip] = {};
		}

		// 新規obj
		if (ESmartMeter.facilities[ip][els.SEOJ] == null) {
			ESmartMeter.facilities[ip][els.SEOJ] = {};
		}

		for (let epc in epcList) {
			// 新規epc
			if (ESmartMeter.facilities[ip][els.SEOJ][epc] == null) {
				ESmartMeter.facilities[ip][els.SEOJ][epc] = {};
			}

			ESmartMeter.facilities[ip][els.SEOJ][epc] = epcList[epc];

			// もしEPC = 0x83の時は識別番号なので，識別番号リストに確保
			if( epc === '83' ) {
				ESmartMeter.identificationNumbers.push( {id: epcList[epc], ip: ip, OBJ: els.SEOJ } );
			}
		}
	} catch (e) {
		console.error("ESmartMeter.renewFacilities error.");
		// console.dir(e);
		throw e;
	}
};

// facilitiesの定期的な監視
// ネットワーク内のEL機器全体情報を更新したらユーザの関数を呼び出す
ESmartMeter.setObserveFacilities = function ( interval, onChanged ) {
	let oldVal = JSON.stringify(ESmartMeter.objectSort(ESmartMeter.facilities));
	const onObserve = function() {
		const newVal = JSON.stringify(ESmartMeter.objectSort(ESmartMeter.facilities));
		if ( oldVal == newVal ) return;
		onChanged();
		oldVal = newVal;
	};

	setInterval( onObserve, interval );
};

// キーでソートしてからJSONにする
// 単純にJSONで比較するとオブジェクトの格納順序の違いだけで比較結果がイコールにならないので
ESmartMeter.objectSort = function (obj) {
	// まずキーのみをソートする
	let keys = Object.keys(obj).sort();

	// 返却する空のオブジェクトを作る
	let map = {};

	// ソート済みのキー順に返却用のオブジェクトに値を格納する
	keys.forEach(function(key){
		map[key] = obj[key];
	});

	return map;
};


// ネットワーク内のEL機器全体情報を検索する
ESmartMeter.searchFacilities = function (ip, obj, epc) {
	try {
		// ipある？
		if (ESmartMeter.facilities[ip] == null) { //見つからない
			return null; // そのIPない
		}
		if( obj == null ) { return ESmartMeter.facilities[ip]; } // IPのみの検索


		// objある？
		if (ESmartMeter.facilities[ip][obj] == null) {
			return null; // そのIP&OBJない
		}
		if( epc == null ) { return ESmartMeter.facilities[ip][obj]; } // IP&OBJの検索

		// epcある？
		if (ESmartMeter.facilities[ip][obj][epc] == null) {
			return null;
		}
		return ESmartMeter.facilities[ip][obj][epc];

	} catch (e) {
		console.error("ESmartMeter.renewFacilities error.");
		// console.dir(e);
		throw e;
	}
};


//////////////////////////////////////////////////////////////////////
// 監視機能 / timer, observation
//////////////////////////////////////////////////////////////////////

ESmartMeter.sleep = function (ms) {
	return new Promise((resolve, reject) => {
		setTimeout(() => {
			resolve();
		}, ms);
	});
};


// 定期的な状態の監視（EPC指定）
// EDTをGetするためのTimer（内部関数）
ESmartMeter.getEDTinTimer = function( ip, obj, epc, base_interval ) {
	// 静的プロパティに関してすでに確保していれば何度もGetしない
	let staticProp = ['80', '81', '82', '8A', '8D', '9D', '9E', '9F', 'D3', 'D7', 'E0', 'E1'];
	if( staticProp.indexOf(epc) != -1 ) {
		if( ESmartMeter.searchFacilities(ip, obj, epc) ) {
			// console.log('-- SM:getEDTinTimer()', ip,obj,epc, 'is skipped.');
			return;
		}
	}

	// console.log('Get', ip, obj, epc);
	ESmartMeter.sendOPC1(ip, '05FF01', obj, '62', epc, [0x00]);

	// 処理をしたので次のタイマーをセット
	if( ESmartMeter.observationTimerEnabled == true ) {
		ESmartMeter.setObservationEPCs( ip, obj, epc, base_interval );
	}
};


// EPC毎にタイマー管理（内部関数）
// ネットワーク負荷分散と家電機器への負荷分散を考慮して
// 同時にアクセスしないよう，intervalをベースに0から30秒のランダム時間を追加してセット
ESmartMeter.setObservationEPCs = function( ip, obj, epc, base_interval ) {
	let rand_interval = Math.round( Math.random() * ESmartMeter.observationDispersion ) + base_interval;
	ESmartMeter.observationTimerID[ ip + '-' +  obj + '-' + epc ] = setTimeout( ESmartMeter.getEDTinTimer, rand_interval, ip, obj, epc, base_interval );
};


// 監視を始める
// configファイルにobservationが設定されていれば実施
ESmartMeter.startObservation = function ( base_interval ) {
	ESmartMeter.debug ? console.log( '-- SM:startObservation,', base_interval, 'ms' ):0;

	// すでに監視していればスキップ
	if( ESmartMeter.observationTimerEnabled == true ) {
		return;
	}

	ESmartMeter.observationTimerEnabled = true;
	if( ESmartMeter.observationEPCs != [] ) { // 監視対象があれば
		ESmartMeter.observationEPCs.forEach( (epc) => {
			ESmartMeter.setObservationEPCs( ESmartMeter.IPv6, '028801', epc, base_interval );
		});
	}
};


// 監視をやめる
ESmartMeter.stopObservation = function() {
	ESmartMeter.observationTimerEnabled = false;
	ESmartMeter.debug ? console.log( '-- SM:stopObservation' ):0;

	for( let key in ESmartMeter.observationTimerID ) {
		clearTimeout( ESmartMeter.observationTimerID[key] );
	}
};


module.exports = ESmartMeter;
//////////////////////////////////////////////////////////////////////
// EOF
//////////////////////////////////////////////////////////////////////
