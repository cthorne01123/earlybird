/////////////////////////////
// Slack specific settings //
/////////////////////////////

var SLACK_BOT = process.env.slackbot ? true : false;
var SLACK_CHANNEL = process.env.slackchannel;
var DEFAULT_TIME_ZONE_OFFSET = process.env.slackdefaultoffset; // Offset from UTC

console.log("SLACK_BOT: " + SLACK_BOT);

// how many seconds to wait before the first awake check
var CHECK1_SECONDS = 60;
var CHECK2_SECONDS = 240;

// Name of message event to listen for
var messageListenEvent = SLACK_BOT ? 'ambient' : 'message_received';

// Comments to greet users in the morning
var comments = [
  "Lovely weather today, don't you think?",
  "What a wonderful day it is!"
];

////////////////////////////////
// Facebook specific settings //
////////////////////////////////

if (!SLACK_BOT) {
  if (!process.env.page_token) {
      console.log('Error: Specify page_token in environment');
      process.exit(1);
  }

  if (!process.env.verify_token) {
      console.log('Error: Specify verify_token in environment');
      process.exit(1);
  }
}

//////////////////
// Initiate bot //
//////////////////

var CronJob = require('cron').CronJob;
var moment = require('moment-timezone');
var Botkit = require('botkit');
var controller;
var bot;

if (SLACK_BOT) {
  controller = Botkit.slackbot({
    json_file_store: "userdata-slack"
  });
  bot = controller.spawn({
    token: "xoxb-36552499799-fBePq3wH0uEier2AcV1jLQZH",
  })
  bot.startRTM(function(err,bot,payload) {
    if (err) {
      throw new Error('Could not connect to Slack');
    } else {
      startUp();
    }
  });
} else {
  controller = Botkit.facebookbot({
    debug: true,
    access_token: process.env.page_token,
    verify_token: process.env.verify_token,
    json_file_store: "userdata-fb"
  });

  bot = controller.spawn({
  });
  controller.setupWebserver(process.env.port || 3000, function(err, webserver) {
    if (err) {
      throw new Error("Could not connect to Facebook");
    } else {
      controller.createWebhookEndpoints(webserver, bot, function() {
	console.log('ONLINE!');
      });

      startUp();
    }
  });
}


var userJobs = {}; // cron jobs for user alarms
var awakeCheckUsers = {}; // users that we are waiting for a response from

// http://stackoverflow.com/a/29170326/5402565
function toDateWithTZ(m) {
  return new Date(m.format('YYYY-MM-DD HH:mm'));
}

function numberWithSign(n) {
  return ((n>=0)?"+":"") + n;
}

function utcOffsetStr(n) {
  return ((n>=0)?"+":"") + (n<10?"0":"") + n + "00";
}

function botSay(message, messageText) {
  if (SLACK_BOT) {
    bot.say(
      {
	text: messageText,
	channel: SLACK_CHANNEL
      }
    );
  } else {
    bot.reply(message, messageText);
  }
}

// Saves are not immediate; need to be careful data that isn't saved isn't overwritten
var pending_user_data = {};

function addOrReplaceStorage(message, new_data) {
  console.log("addOrReplaceStorage: " + message.user);

  var handler = function(err, user_data) {
    if (user_data == undefined) {
      console.log("addOrReplaceStorage: new user_data");
      user_data = {id: message.user};
    } else {
      console.log("addOrReplaceStorage: existing user_data");
      console.log(user_data);
    }
    
    for (var key in new_data) {
      if (new_data.hasOwnProperty(key)) {
	console.log("addOrReplaceStorage key: " + key + "/" + new_data[key]);
	user_data[key] = new_data[key];
      }
    }

    console.log("Saving");
    console.log(user_data);

    pending_user_data[message.user] = user_data;

    controller.storage.users.save(user_data, function(err) {
      console.log("addOrReplaceStorage err: " + err);
      pending_user_data[message.user] = undefined;
    });
  };

  if (pending_user_data[message.user])
    handler(null, pending_user_data[message.user]);
  else
    controller.storage.users.get(message.user, handler);
}

function saveTimeZone(message, zoneOffset, silentSet) {
  if (!silentSet)
    bot.reply(message, "Ok, I set your timezone to UTC" + numberWithSign(zoneOffset));
  addOrReplaceStorage(message, {zoneOffset: zoneOffset});
}

function calcUserZone(message, callback, errorRecall) {
  bot.startConversation(message, function(err,convo) {
    var messageText = errorRecall ? ":'( I'm really sorry, but I can't understand that time format. :'( Can you type it like this example for me? 20:27" :"Can you tell me what time it is currently (e.g. 20:" + moment().format("mm") + ") so I can work out your timezone?";

    convo.ask(messageText, function(response,convo) {
      if (response.text.toLowerCase().match(/cancel|no/)) {
	convo.say("Ok.");
	convo.next();
	return;
      }

      var usernow = moment(response.text, "HH:mm");
      if (!usernow.isValid()) {
	calcUserZone(message, callback, true);
      } else {
	var now = moment().tz("UTC");
	var uh = usernow.hour();
	var nh = now.hour();
	// 23 - 1: -2
	// 1 - 23: +2
	// 7 - 12: -5
	// 12 - 7: +5

	// 12 - 10: 0

	var d = uh-nh;
	console.log(nh, uh, d);
	if (d > 12 || d < -14)
	  d = (nh>uh) ? (24-nh)+uh : (24-uh)+nh;
	
	// These signs seem to be backwards for moment?
	//var zone = "Etc/GMT" + ((d>=0)?"+":"-") + d;
	var zoneStr = "UTC" + numberWithSign(d);
	var zoneOffset = d;
	
	//convo.say("Ok, it looks like your timezone is " + zoneStr + " and it's currently " + now.utcOffset(zoneOffset).format("HH:mm") + ". (Type zone again if you want to change this)");
	
	saveTimeZone(message, zoneOffset, true);
	callback(zoneOffset, "Ok, it looks like your timezone is " + zoneStr + " and it's currently " + now.utcOffset(zoneOffset).format("HH:mm") + ". (Type zone again if you want to change this)");
      }
      
      convo.next();
    });
  })      
}

function readUserZone(message, callback) {
  controller.storage.users.get(message.user, function(err, user_data) {
    console.log("readUserZone");
    console.log(user_data);
    if (user_data && user_data.zoneOffset != undefined) {
      callback(user_data.zoneOffset);
    } else {
      if (SLACK_BOT) {
	callback(DEFAULT_TIME_ZONE_OFFSET);
	return;
      }
      calcUserZone(message, callback);
    }
  });
}

function readUserName(userId, callback) {
  if (SLACK_BOT) {
    bot.api.users.list({}, function(err,response) {
      for (var i = 0; i < response.members.length; i++) {
	var member = response.members[i];
	if (member.id == userId)
	  callback(member.name);
      }
    });
  } else {
    callback(null);
  }
}

function getRandomComment() {
  var r = Math.floor(Math.random()*comments.length);
  return comments[r];
}

function awakeCheck1(userId, userName, message) {
  var promptMessage = SLACK_BOT ? "Hello, @" + userName + "?" : "Hello?";
  botSay(message, promptMessage + " You said you wanted to wake up at this time, right?\nAre you there?");

  var check2 = moment().add(CHECK2_SECONDS, 'seconds');

  // create new job
  var job = new CronJob(check2.toDate(), function() {
    awakeCheck2(userId, userName, message);
  });
  // start job
  job.start();


  awakeCheckUsers[userId].checkJob = job;
}

function awakeCheck2(userId, userName, message) {
  var promptMessage = SLACK_BOT ? "It seems @" + userName + " has overslept..." : "I guess you overslept...";
  botSay(message, promptMessage);

  awakeCheckUsers[userId].overslept = true;
}

function wakeUpUser(userId, userName, message) {
  var greetingMessage = SLACK_BOT ? "Good morning, @" + userName + "!" : "Good morning!";
  botSay(message, greetingMessage + "\n" + getRandomComment() + "\nAre you awake?");
 
  var check1 = moment().add(CHECK1_SECONDS, 'seconds');

  // create new job
  var job = new CronJob(check1.toDate(), function() {
    awakeCheck1(userId, userName, message);
  });
  // start job
  job.start();
  
  // store user info
  awakeCheckUsers[userId] = {checkJob: job, name: userName};

  // unpersist
  addOrReplaceStorage(message, {pending_alarm: undefined});
}

controller.on(messageListenEvent, function(bot, message) {
  var userId = message.user;
  if (awakeCheckUsers[userId]) {
    var userName = awakeCheckUsers[userId].name;
    if (awakeCheckUsers[userId].overslept) {
      var greetingMessage = SLACK_BOT ? "hello @" + userName : "hello";
      bot.reply(message, "Oh, " + greetingMessage + "... sleep well? A bit... too well, maybe?");
    } else {
      var greetingMessage = SLACK_BOT ? "Great to see you're awake on time, @" + userName + "!\nWell done :)" : "Great to see you're awake on time!\nWell done :)";
      bot.reply(message, greetingMessage);
      awakeCheckUsers[userId].checkJob.stop();
    }

    awakeCheckUsers[userId] = undefined;

    return false;
  }
});

controller.hears(['hi', 'hey', 'hello'],messageListenEvent,function(bot,message) {
bot.reply(message, "Hi :) Tell me what time you want to wake up (e.g. 07:00) and I'll message you at that time to see if you're awake!\n (Type help if you get stuck)");
});

controller.hears('^help$',messageListenEvent,function(bot,message) {
  console.log(message);

  bot.reply(message, "Tell me what time you want to wake up (e.g. 07:00) and I'll message you at that time to see if you're awake!\nType help2 for more help.");
  /*bot.reply(message, "Hello, I'm Early Bird! I can help you wake up early in the morning.");
  bot.reply(message, "Here's a list of my commands:");
  bot.reply(message, "*<time>*: tell me the time you want to wake up tomorrow morning, e.g. 07:00 or 7");
  bot.reply(message, "*forget*: tell me to forget the time you want to wake up tomorrow morning");
  bot.reply(message, "*zone <timezone string>*: tell me your timezone, e.g. zone Europe/London (default Asia/Tokyo)");
  bot.reply(message, "*zone*: ask me your current timezone");*/
});

controller.hears('help2',messageListenEvent,function(bot,message) {
  bot.reply(message, "To change your timezone, just type zone.\nType help3 for more help.");
});

controller.hears('help3',messageListenEvent,function(bot,message) {
  bot.reply(message, "To make me forget what you said about waking up early, just type forget");
});

controller.hears('^zone',messageListenEvent,function(bot,message) {
  calcUserZone(message, function(zoneOffset, setMessageText) {
    bot.reply(message, setMessageText);
  });

  /*readUserZone(message, function(zoneOffset, setAfterQuestion) {
    //if (setAfterQuestion)
    //  bot.reply(message, "Ok, I set your timezone to UTC" + numberWithSign(zoneOffset));
    //else
      //bot.reply(message, "Your timezone is set to UTC" + numberWithSign(zoneOffset) + " and it's currently " + moment().utcOffset(zoneOffset).format("HH:mm") + ". (Type zone again if you want to change this)");
  });*/
});

/*controller.hears('zone (.+)',messageListenEvent,function(bot,message) {
  saveTimeZone(message, message.match[1]);
});*/

controller.hears('^forget$',messageListenEvent,function(bot,message) {
  var userId = message.user;
  if (userJobs[userId]) {
    userJobs[userId].stop();
    userJobs[userId] = undefined;
    addOrReplaceStorage(message, {pending_alarm: undefined});
    bot.reply(message, 'Ok!');    
  } else {
    bot.reply(message, 'There is nothing to forget.');
  }
});

controller.hears('^forget zone$',messageListenEvent,function(bot,message) {
  addOrReplaceStorage(message, {zoneOffset: undefined});
  bot.reply(message, "Done :)");
});

controller.hears('^([0-9]|0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$|^([0-9]|0[0-9]|1[0-9]|2[0-3])$|^_test_$',messageListenEvent,function(bot,message) {
  var userId = message.user;

  readUserZone(message, function(zoneOffset, setMessageText) {
    console.log(message.match[0], zoneOffset);

    var now = moment();
    var alarm;
    if (message.match[0] == '_test_') {
      alarm = moment().add(1, 'seconds');
    } else {
      // Determine format of input
      var fmt;
      if (message.match[0].indexOf(":") == -1)
	fmt = "HH ZZ";
      else
	fmt = "HH:mm ZZ";

      // Read time using format
      alarm = moment(message.match[0] + " " + utcOffsetStr(zoneOffset), fmt);

      // Get time for timezone
      //alarm = moment.tz(alarm.format("HH:mm"), "HH:mm", "UTC");

      if (alarm < now)
        alarm.add(1, 'days');
    }

    if (setMessageText)
      bot.reply(message, setMessageText + "\nSee you at " + alarm.utcOffset(zoneOffset).format('HH:mm') + " :D!");
    else
      bot.reply(message, "Ok, see you at " + alarm.utcOffset(zoneOffset).format('HH:mm') + " :D!");

    // check if user already has a job running
    var activeJob = userJobs[userId];
    if (activeJob) {
      console.log("cancelling job first...");
      activeJob.stop();
    } else {
      console.log("no job active to stop");
    }

    // create new job
    startWakeUpJob(message, alarm.toDate());

    // persist
    console.log("persist!");
    console.log(message);
    addOrReplaceStorage(message, {pending_alarm: alarm.toDate(), last_message: message});
  });
});

function startWakeUpJob(message, date) {
  var userId = message.user;
  
  // create new job
  var job = new CronJob(date, function() {
    console.log("cron!");
    
    readUserName(userId, function(userName) {
      wakeUpUser(userId, userName, message);
    });

    userJobs[userId] = undefined;
  });
  // start job
  job.start();
  // save with user
  userJobs[message.user] = job;
}

function startUp() {
  console.log("startup!");
  
  controller.storage.users.all(function(err, all_user_data) {
    for (var key in all_user_data) {
      if (all_user_data.hasOwnProperty(key)) {
	var user_data = all_user_data[key];
	//console.log(user_data);
	if (user_data.pending_alarm) {
	  console.log("found pending:" + user_data.id);
	  console.log(user_data);
	  
	  var alarm = moment(user_data.pending_alarm);
	  var now = moment();
	  if (now >= alarm) {
	    //bot.reply(user_data.last_message, "Sorry I missed your last alarm. I was having some problems!");
	    addOrReplaceStorage(user_data.last_message, {pending_alarm: undefined});
	    console.log("missed alarm");
	  } else {
	    startWakeUpJob(user_data.last_message, alarm.toDate());
	  }
	}
      }
    }
  });
}
