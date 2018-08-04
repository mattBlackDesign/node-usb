var binary = require('node-pre-gyp');
var path = require('path');
var binding_path = binary.find(path.resolve(path.join(__dirname,'./package.json')));

var usb = exports = module.exports = require(binding_path);
var events = require('events')
var util = require('util')

Object.keys(events.EventEmitter.prototype).forEach(function (key) {
	exports[key] = events.EventEmitter.prototype[key];
});

// convenience method for finding a device by vendor and product id
exports.findByIds = function(vid, pid) {
	var devices = usb.getDeviceList()

	for (var i = 0; i < devices.length; i++) {
		var deviceDesc = devices[i].deviceDescriptor
		if ((deviceDesc.idVendor == vid) && (deviceDesc.idProduct == pid)) {
			return devices[i]
		}
	}
}

function Interface(device, id){
	this.device = device
	this.id = id
	this.altSetting = 0;
	this.__refresh()
}

Interface.prototype.__refresh = function(){
	this.descriptor = this.device.configDescriptor.interfaces[this.id][this.altSetting]
	this.interfaceNumber = this.descriptor.bInterfaceNumber
	this.endpoints = []
	var len = this.descriptor.endpoints.length
	for (var i=0; i<len; i++){
		var desc = this.descriptor.endpoints[i]
		var c = (desc.bEndpointAddress&usb.LIBUSB_ENDPOINT_IN)?InEndpoint:OutEndpoint
		this.endpoints[i] = new c(this.device, desc)
	}
}

Interface.prototype.claim = function(){
	this.device.__claimInterface(this.id)
}

Interface.prototype.release = function(closeEndpoints, cb){
	var self = this;
	if (typeof closeEndpoints == 'function') {
		cb = closeEndpoints;
		closeEndpoints = null;
	}

	if (!closeEndpoints || this.endpoints.length == 0) {
		next();
	} else {
		var n = self.endpoints.length;
		self.endpoints.forEach(function (ep, i) {
			if (ep.pollActive) {
				ep.once('end', function () {
					if (--n == 0) next();
				});
				ep.stopPoll();
			} else {
				if (--n == 0) next();
			}
		});
	}

	function next () {
		self.device.__releaseInterface(self.id, function(err){
			if (!err){
				self.altSetting = 0;
				self.__refresh()
			}
			cb.call(self, err)
		})
	}
}

Interface.prototype.isKernelDriverActive = function(){
	return this.device.__isKernelDriverActive(this.id)
}

Interface.prototype.detachKernelDriver = function() {
	return this.device.__detachKernelDriver(this.id)
};

Interface.prototype.attachKernelDriver = function() {
	return this.device.__attachKernelDriver(this.id)
};


Interface.prototype.setAltSetting = function(altSetting, cb){
	var self = this;
	this.device.__setInterface(this.id, altSetting, function(err){
		if (!err){
			self.altSetting = altSetting;
			self.__refresh();
		}
		cb.call(self, err)
	})

}

Interface.prototype.endpoint = function(addr){
	for (var i=0; i<this.endpoints.length; i++){
		if (this.endpoints[i].address == addr){
			return this.endpoints[i]
		}
	}
}

function Endpoint(device, descriptor){
	this.device = device
	this.descriptor = descriptor
	this.address = descriptor.bEndpointAddress
	this.transferType = descriptor.bmAttributes&0x03
}
util.inherits(Endpoint, events.EventEmitter)

Endpoint.prototype.timeout = 0

Endpoint.prototype.makeTransfer = function(timeout, callback){
	return new usb.Transfer(this.device, this.address, this.transferType, timeout, callback)
}

Endpoint.prototype.startPoll = function(nTransfers, transferSize, callback){
	if (this.pollTransfers){
		throw new Error("Polling already active")
	}

	nTransfers = nTransfers || 3;
	this.pollTransferSize = transferSize || this.descriptor.wMaxPacketSize;
	this.pollActive = true
	this.pollPending = 0

	var transfers = []
	for (var i=0; i<nTransfers; i++){
		transfers[i] = this.makeTransfer(0, callback)
	}
	return transfers;
}

Endpoint.prototype.stopPoll = function(cb){
	if (!this.pollTransfers) {
		throw new Error('Polling is not active.');
	}
	for (var i=0; i<this.pollTransfers.length; i++){
		try {
			this.pollTransfers[i].cancel()
		} catch (err) {
			this.emit('error', err);
		}
	}
	this.pollActive = false
	if (cb) this.once('end', cb);
}

function InEndpoint(device, descriptor){
	Endpoint.call(this, device, descriptor)
}

exports.InEndpoint = InEndpoint
util.inherits(InEndpoint, Endpoint)
InEndpoint.prototype.direction = "in"

InEndpoint.prototype.transfer = function(length, cb){
	var self = this
	var buffer = new Buffer(length)

	function callback(error, buf, actual){
		cb.call(self, error, buffer.slice(0, actual))
	}

	try {
		this.makeTransfer(this.timeout, callback).submit(buffer)
	} catch (e) {
		process.nextTick(function() { cb.call(self, e); });
	}
	return this;
}

InEndpoint.prototype.startPoll = function(nTransfers, transferSize){
	var self = this
	this.pollTransfers = InEndpoint.super_.prototype.startPoll.call(this, nTransfers, transferSize, transferDone)

	function transferDone(error, buf, actual){
		if (!error){
			self.emit("data", buf.slice(0, actual))
		}else if (error.errno != usb.LIBUSB_TRANSFER_CANCELLED){
			self.emit("error", error)
			self.stopPoll()
		}

		if (self.pollActive){
			startTransfer(this)
		}else{
			self.pollPending--

			if (self.pollPending == 0){
				self.emit('end')
			}
		}
	}

	function startTransfer(t){
		try {
			t.submit(new Buffer(self.pollTransferSize), transferDone);
		} catch (e) {
			self.emit("error", e);
			self.stopPoll();
		}
	}

	this.pollTransfers.forEach(startTransfer)
	self.pollPending = this.pollTransfers.length
}



function OutEndpoint(device, descriptor){
	Endpoint.call(this, device, descriptor)
}
exports.OutEndpoint = OutEndpoint
util.inherits(OutEndpoint, Endpoint)
OutEndpoint.prototype.direction = "out"

OutEndpoint.prototype.transfer = function(buffer, cb){
	var self = this
	if (!buffer){
		buffer = new Buffer(0)
	}else if (!Buffer.isBuffer(buffer)){
		buffer = new Buffer(buffer)
	}

	function callback(error, buf, actual){
		if (cb) cb.call(self, error)
	}

	try {
		this.makeTransfer(this.timeout, callback).submit(buffer);
	} catch (e) {
		process.nextTick(function() { callback(e); });
	}

	return this;
}

OutEndpoint.prototype.transferWithZLP = function (buf, cb) {
	if (buf.length % this.descriptor.wMaxPacketSize == 0) {
		this.transfer(buf);
		this.transfer(new Buffer(0), cb);
	} else {
		this.transfer(buf, cb);
	}
}

var hotplugListeners = 0;
exports.on('newListener', function(name) {
	if (name !== 'attach' && name !== 'detach') return;
	if (++hotplugListeners === 1) usb._enableHotplugEvents();
});

exports.on('removeListener', function(name) {
	if (name !== 'attach' && name !== 'detach') return;
	if (--hotplugListeners === 0) usb._disableHotplugEvents();
});
