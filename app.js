/**
 * Copyright 2015 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

require( 'dotenv' ).config( {silent: true} );


var express = require( 'express' );  // app server
var bodyParser = require( 'body-parser' );  // parser for post requests
var watson = require( 'watson-developer-cloud' );  // watson sdk
var http = require('http');

// The following requires are needed for logging purposes
var uuid = require( 'uuid' );
var vcapServices = require( 'vcap_services' );
var basicAuth = require( 'basic-auth-connect' );

// The app owner may optionally configure a cloudand db to track user input.
// This cloudand db is not required, the app will operate without it.
// If logging is enabled the app must also enable basic auth to secure logging
// endpoints
var cloudantCredentials = vcapServices.getCredentials( 'cloudantNoSQLDB' );
var cloudantUrl = null;
if ( cloudantCredentials ) {
  cloudantUrl = cloudantCredentials.url;
}
cloudantUrl = cloudantUrl || process.env.CLOUDANT_URL; // || '<cloudant_url>';
var logs = null;
var app = express();

// Create the inventory
getInventory();

// Bootstrap application settings
app.use( express.static( './public' ) ); // load UI from public folder
app.use( bodyParser.json() );

// Create the service wrapper
var conversation = watson.conversation( {
  url: 'https://gateway.watsonplatform.net/conversation/api',
  username: process.env.CONVERSATION_USERNAME || '<username>',
  password: process.env.CONVERSATION_PASSWORD || '<password>',
  version_date: '2016-07-11',
  version: 'v1'
} );

// Endpoint to be call from the client side
app.post( '/api/message', function (req, res) {
  var workspace = process.env.WORKSPACE_ID || '<workspace-id>';
  if ( !workspace || workspace === '<workspace-id>' ) {
    return res.json( {
      'output': {
        'text': 'The app has not been configured with a <b>WORKSPACE_ID</b> environment variable. Please refer to the ' +
        '<a href="https://github.com/watson-developer-cloud/conversation-simple">README</a> documentation on how to set this variable. <br>'
      }
    } );
  }
  var payload = {
    workspace_id: workspace,
    context: {},
    input: {}
  };
  if ( req.body ) {
    if ( req.body.input ) {
      payload.input = req.body.input;
    }
    if ( req.body.context ) {
      // The client must maintain context/state
      payload.context = req.body.context;
    }
  }
  // Send the input to the conversation service
  conversation.message( payload, function (err, data) {
    if ( err ) {
      return res.status( err.code || 500 ).json( err );
    }
    updateMessage(res, payload, data);
  } );
} );

/**
 * Updates the response text using the intent confidence
 * @param  {Object} input The request to the Conversation service
 * @param  {Object} response The response from the Conversation service
 * @return {Object}          The response with the updated message
 */
function updateMessage(res, input, data) {
  // Intent is order
  // return appropriate response given availability of item
  if (isOrder(data)) {
    var params = [];
    var orderExists = 1;
    var quantity = 1;

    // Get quantity
    for (var i = 0; i < data.entities.length; i++) {
      if (data.entities[i].entity === 'number')
        quantity = data.entities[i].value;
    }

    // Check that every item in the order is in stock
    for (var i = 0; i < data.entities.length; i++) {
      if (!(data.entities[i].entity === 'number')) {
        var item = data.entities[i].value;

        // If an item isn't in inventory, can't place order
        if (!checkInventory(item, quantity)) {
          console.log(item);
          orderExists = 0;
          params.push('Unfortunately, we\'re all out of that item today.');
          break;
        }
      }
    }
    if (orderExists == 1) {
      params.push('Great! We\'ve added your order to the cart.');
    }
    data.output.text = replaceParams( data.output.text, params );
    return res.json(data);
  }
  // Intent is provide_id
  // get current estimated time
  else if (isProvideID(data)) {
    var params = [];
    var wait_time = 10;
    params.push(wait_time);
    data.output.text = replaceParams( data.output.text, params );
    return res.json(data);
  }
  else {
    return res.json(data);
  }
}

// Returns true if the intent is order
function isOrder(data) {
  return data.intents && data.intents.length > 0 && data.intents[0].intent === 'order'
    && data.entities && data.entities.length > 0;
}

// Returns true if this is the customer's first order
function isFirstOrder(data) {
  return data.context.numOrders == 1;
}

// Returns true if the intent is provide_id
function isProvideID(data) {
  return data.intents && data.intents.length > 0 && data.intents[0].intent === 'provide_id';
}

// Creates and returns the starting inventory
function getInventory() {
  httpGet('https://4ee9ee41-95ed-4e7d-b0e8-20762562a5e7-bluemix.cloudant.com/kaf-items/_all_docs?key="1"&include_docs=true');
}

// GET HTTP Request function
function httpGet(theUrl)
{
  var restler = require('restler');
  var options = {
    username: process.env.NO_SQL_USERNAME,
    password: process.env.NO_SQL_PASSWORD
  };

  restler.get(theUrl, options).on('complete', function (data) {
    console.log(data.rows[0]);
  });
}

// Checks the inventory for an item (entity)
// Returns true if item is available
function checkInventory(item, quantity) {
  if (inventory[item] >= quantity) {
    inventory[item] -= quantity;
    return true;
  }
  return false;
}

function replaceParams(original, args) {
  if (original && args) {
    var text = original.join(' ').replace(/{(\d+)}/g, function (match, number) {
      return typeof args[number] != 'undefined'
        ? args[number]
        : match
        ;
    });
    return [text];
  }
  return original;
}


if ( cloudantUrl ) {
  // If logging has been enabled (as signalled by the presence of the cloudantUrl) then the
  // app developer must also specify a LOG_USER and LOG_PASS env vars.
  if ( !process.env.LOG_USER || !process.env.LOG_PASS ) {
    throw new Error( 'LOG_USER OR LOG_PASS not defined, both required to enable logging!' );
  }
  // add basic auth to the endpoints to retrieve the logs!
  var auth = basicAuth( process.env.LOG_USER, process.env.LOG_PASS );
  // If the cloudantUrl has been configured then we will want to set up a nano client
  var nano = require( 'nano' )( cloudantUrl );
  // add a new API which allows us to retrieve the logs (note this is not secure)
  nano.db.get( 'kaf_logs', function (err) {
    if ( err ) {
      console.error(err);
      nano.db.create( 'kaf_logs', function (errCreate) {
        console.error(errCreate);
        logs = nano.db.use( 'kaf_logs' );
      } );
    } else {
      logs = nano.db.use( 'kaf_logs' );
    }
  } );

  // Endpoint which allows deletion of db
  app.post( '/clearDb', auth, function (req, res) {
    nano.db.destroy( 'kaf_logs', function () {
      nano.db.create( 'kaf_logs', function () {
        logs = nano.db.use( 'kaf_logs' );
      } );
    } );
    return res.json( {'message': 'Clearing db'} );
  } );

  // Endpoint which allows conversation logs to be fetched
  app.get( '/chats', auth, function (req, res) {
    logs.list( {include_docs: true, 'descending': true}, function (err, body) {
      console.error(err);
      // download as CSV
      var csv = [];
      csv.push( ['Question', 'Intent', 'Confidence', 'Entity', 'Output', 'Time'] );
      body.rows.sort( function (a, b) {
        if ( a && b && a.doc && b.doc ) {
          var date1 = new Date( a.doc.time );
          var date2 = new Date( b.doc.time );
          var t1 = date1.getTime();
          var t2 = date2.getTime();
          var aGreaterThanB = t1 > t2;
          var equal = t1 === t2;
          if (aGreaterThanB) {
            return 1;
          }
          return  equal ? 0 : -1;
        }
      } );
      body.rows.forEach( function (row) {
        var question = '';
        var intent = '';
        var confidence = 0;
        var time = '';
        var entity = '';
        var outputText = '';
        if ( row.doc ) {
          var doc = row.doc;
          if ( doc.request && doc.request.input ) {
            question = doc.request.input.text;
          }
          if ( doc.response ) {
            intent = '<no intent>';
            if ( doc.response.intents && doc.response.intents.length > 0 ) {
              intent = doc.response.intents[0].intent;
              confidence = doc.response.intents[0].confidence;
            }
            entity = '<no entity>';
            if ( doc.response.entities && doc.response.entities.length > 0 ) {
              entity = doc.response.entities[0].entity + ' : ' + doc.response.entities[0].value;
            }
            outputText = '<no dialog>';
            if ( doc.response.output && doc.response.output.text ) {
              outputText = doc.response.output.text.join( ' ' );
            }
          }
          time = new Date( doc.time ).toLocaleString();
        }
        csv.push( [question, intent, confidence, entity, outputText, time] );
      } );
      res.csv( csv );
    } );
  } );
}

module.exports = app;
