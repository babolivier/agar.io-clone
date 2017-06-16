/*jslint bitwise: true, node: true, loopfunc: true */
'use strict';

var express = require('express');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var SAT = require('sat');
var sql = require ("mysql");

// Import game settings.
var c = require('../../config.json');

// Import utilities.
var util = require('./lib/util');

// Import quadtree.
var quadtree = require('simple-quadtree');

//call sqlinfo
var s = c.sqlinfo;

var tree = quadtree(0, 0, c.gameWidth, c.gameHeight);

var rooms = {};

/*****
 * A room will follow this schema:
 * roomName: {
 *     users: Array,
 *     massFood: Array,
 *     food: Array,
 *     virus: Array,
 *     sockets: Array,
 *     leaderboard: Array,
 *     leaderboardChanged: boolean
 * }
******/

var V = SAT.Vector;
var C = SAT.Circle;

if(s.host !== "DEFAULT") {
    var pool = sql.createConnection({
        host: s.host,
        user: s.user,
        password: s.password,
        database: s.database
    });

    //log sql errors
    pool.connect(function(err){
        if (err){
            console.log (err);
        }
    });
}

var initMassLog = util.log(c.defaultPlayerMass, c.slowBase);

app.use(express.static(__dirname + '/../client'));

function addFood(toAdd, room) {
    var radius = util.massToRadius(c.foodMass);
    while (toAdd--) {
        var position = c.foodUniformDisposition ? util.uniformPosition(rooms[room].food, radius) : util.randomPosition(radius);
        rooms[room].food.push({
            // Make IDs unique.
            id: ((new Date()).getTime() + '' + rooms[room].food.length) >>> 0,
            x: position.x,
            y: position.y,
            radius: radius,
            mass: Math.random() + 2,
            hue: Math.round(Math.random() * 360)
        });
    }
}

function addVirus(toAdd, room) {
    while (toAdd--) {
        var mass = util.randomInRange(c.virus.defaultMass.from, c.virus.defaultMass.to, true);
        var radius = util.massToRadius(mass);
        var position = c.virusUniformDisposition ? util.uniformPosition(rooms[room].virus, radius) : util.randomPosition(radius);
        rooms[room].virus.push({
            id: ((new Date()).getTime() + '' + rooms[room].virus.length) >>> 0,
            x: position.x,
            y: position.y,
            radius: radius,
            mass: mass,
            fill: c.virus.fill,
            stroke: c.virus.stroke,
            strokeWidth: c.virus.strokeWidth
        });
    }
}

function removeFood(toRem, room) {
    while (toRem--) {
        rooms[room].food.pop();
    }
}

function movePlayer(player) {
    var x =0,y =0;
    for(var i=0; i<player.cells.length; i++)
    {
        var target = {
            x: player.x - player.cells[i].x + player.target.x,
            y: player.y - player.cells[i].y + player.target.y
        };
        var dist = Math.sqrt(Math.pow(target.y, 2) + Math.pow(target.x, 2));
        var deg = Math.atan2(target.y, target.x);
        var slowDown = 1;
        if(player.cells[i].speed <= 6.25) {
            slowDown = util.log(player.cells[i].mass, c.slowBase) - initMassLog + 1;
        }

        var deltaY = player.cells[i].speed * Math.sin(deg)/ slowDown;
        var deltaX = player.cells[i].speed * Math.cos(deg)/ slowDown;

        if(player.cells[i].speed > 6.25) {
            player.cells[i].speed -= 0.5;
        }
        if (dist < (50 + player.cells[i].radius)) {
            deltaY *= dist / (50 + player.cells[i].radius);
            deltaX *= dist / (50 + player.cells[i].radius);
        }
        if (!isNaN(deltaY)) {
            player.cells[i].y += deltaY;
        }
        if (!isNaN(deltaX)) {
            player.cells[i].x += deltaX;
        }
        // Find best solution.
        for(var j=0; j<player.cells.length; j++) {
            if(j != i && player.cells[i] !== undefined) {
                var distance = Math.sqrt(Math.pow(player.cells[j].y-player.cells[i].y,2) + Math.pow(player.cells[j].x-player.cells[i].x,2));
                var radiusTotal = (player.cells[i].radius + player.cells[j].radius);
                if(distance < radiusTotal) {
                    if(player.lastSplit > new Date().getTime() - 1000 * c.mergeTimer) {
                        if(player.cells[i].x < player.cells[j].x) {
                            player.cells[i].x--;
                        } else if(player.cells[i].x > player.cells[j].x) {
                            player.cells[i].x++;
                        }
                        if(player.cells[i].y < player.cells[j].y) {
                            player.cells[i].y--;
                        } else if((player.cells[i].y > player.cells[j].y)) {
                            player.cells[i].y++;
                        }
                    }
                    else if(distance < radiusTotal / 1.75) {
                        player.cells[i].mass += player.cells[j].mass;
                        player.cells[i].radius = util.massToRadius(player.cells[i].mass);
                        player.cells.splice(j, 1);
                    }
                }
            }
        }
        if(player.cells.length > i) {
            var borderCalc = player.cells[i].radius / 3;
            if (player.cells[i].x > c.gameWidth - borderCalc) {
                player.cells[i].x = c.gameWidth - borderCalc;
            }
            if (player.cells[i].y > c.gameHeight - borderCalc) {
                player.cells[i].y = c.gameHeight - borderCalc;
            }
            if (player.cells[i].x < borderCalc) {
                player.cells[i].x = borderCalc;
            }
            if (player.cells[i].y < borderCalc) {
                player.cells[i].y = borderCalc;
            }
            x += player.cells[i].x;
            y += player.cells[i].y;
        }
    }
    player.x = x/player.cells.length;
    player.y = y/player.cells.length;
}

function moveMass(mass) {
    var deg = Math.atan2(mass.target.y, mass.target.x);
    var deltaY = mass.speed * Math.sin(deg);
    var deltaX = mass.speed * Math.cos(deg);

    mass.speed -= 0.5;
    if(mass.speed < 0) {
        mass.speed = 0;
    }
    if (!isNaN(deltaY)) {
        mass.y += deltaY;
    }
    if (!isNaN(deltaX)) {
        mass.x += deltaX;
    }

    var borderCalc = mass.radius + 5;

    if (mass.x > c.gameWidth - borderCalc) {
        mass.x = c.gameWidth - borderCalc;
    }
    if (mass.y > c.gameHeight - borderCalc) {
        mass.y = c.gameHeight - borderCalc;
    }
    if (mass.x < borderCalc) {
        mass.x = borderCalc;
    }
    if (mass.y < borderCalc) {
        mass.y = borderCalc;
    }
}

function balanceMass(room) {
    var totalMass = rooms[room].food.length * c.foodMass +
        rooms[room].users
            .map(function(u) {return u.massTotal; })
            .reduce(function(pu,cu) { return pu+cu;}, 0);

    var massDiff = c.gameMass - totalMass;
    var maxFoodDiff = c.maxFood - rooms[room].food.length;
    var foodDiff = parseInt(massDiff / c.foodMass) - maxFoodDiff;
    var foodToAdd = Math.min(foodDiff, maxFoodDiff);
    var foodToRemove = -Math.max(foodDiff, maxFoodDiff);

    if (foodToAdd > 0) {
        //console.log('[DEBUG] Adding ' + foodToAdd + ' food to level!');
        addFood(foodToAdd, room);
        //console.log('[DEBUG] Mass rebalanced!');
    }
    else if (foodToRemove > 0) {
        //console.log('[DEBUG] Removing ' + foodToRemove + ' food from level!');
        removeFood(foodToRemove, room);
        //console.log('[DEBUG] Mass rebalanced!');
    }

    var virusToAdd = c.maxVirus - rooms[room].virus.length;

    if (virusToAdd > 0) {
        addVirus(virusToAdd, room);
    }
}

io.on('connection', function (socket) {
    let player;
    let room = socket.handshake.query.room;
    var type = socket.handshake.query.type;
    console.log('A', type, 'user connected on', room,'!');
    socket.join(room);

    // Init the room
    if(!rooms[room]) {
        rooms[room] = {
            users: [],
            massFood: [],
            food: [],
            virus: [],
            sockets: {},
            leaderboard: [],
            leaderboardChanged: false
        };
    }
    
    var radius = util.massToRadius(c.defaultPlayerMass);
    var position = c.newPlayerInitialPosition == 'farthest' ? util.uniformPosition(rooms[room].users, radius) : util.randomPosition(radius);

    var cells = [];
    var massTotal = 0;
    if(type === 'player') {
        cells = [{
            mass: c.defaultPlayerMass,
            x: position.x,
            y: position.y,
            radius: radius
        }];
        massTotal = c.defaultPlayerMass;
    }

    var currentPlayer = {
        id: socket.id,
        x: position.x,
        y: position.y,
        w: c.defaultPlayerMass,
        h: c.defaultPlayerMass,
        cells: cells,
        massTotal: massTotal,
        hue: Math.round(Math.random() * 360),
        type: type,
        lastHeartbeat: new Date().getTime(),
        target: {
            x: 0,
            y: 0
        }
    };

    socket.on('gotit', function (player) {
        console.log('[INFO] Player ' + player.name + ' connecting on room '+ room +'!');

        if (util.findIndex(rooms[room].users, player.id) > -1) {
            console.log('[INFO] Player ID is already connected, kicking.');
            socket.disconnect();
        // } else if (!util.validNick(player.name)) {
        //     socket.emit('kick', 'Invalid username.');
        //     socket.disconnect();
        } else {
            console.log('[INFO] Player ' + player.name + ' connected!');
            rooms[room].sockets[player.id] = socket;

            var radius = util.massToRadius(c.defaultPlayerMass);
            var position = c.newPlayerInitialPosition == 'farthest' ? util.uniformPosition(rooms[room].users, radius) : util.randomPosition(radius);

            player.x = position.x;
            player.y = position.y;
            player.target.x = 0;
            player.target.y = 0;
            if(type === 'player') {
                player.cells = [{
                    mass: c.defaultPlayerMass,
                    x: position.x,
                    y: position.y,
                    radius: radius
                }];
                player.massTotal = c.defaultPlayerMass;
            }
            else {
                 player.cells = [];
                 player.massTotal = 0;
            }
            player.hue = Math.round(Math.random() * 360);
            currentPlayer = player;
            currentPlayer.lastHeartbeat = new Date().getTime();
            rooms[room].users.push(currentPlayer);

            io.to(room).emit('playerJoin', { name: currentPlayer.name });

            socket.emit('gameSetup', {
                gameWidth: c.gameWidth,
                gameHeight: c.gameHeight
            });
            console.log('Total players in room '+ room +': ' + rooms[room].users.length);
        }

    });

    socket.on('pingcheck', function () {
        socket.emit('pongcheck');
    });

    socket.on('windowResized', function (data) {
        currentPlayer.screenWidth = data.screenWidth;
        currentPlayer.screenHeight = data.screenHeight;
    });

    socket.on('respawn', function () {
        if (util.findIndex(rooms[room].users, currentPlayer.id) > -1)
            rooms[room].users.splice(util.findIndex(rooms[room].users, currentPlayer.id), 1);
        socket.emit('welcome', currentPlayer);
        console.log('[INFO] User ' + currentPlayer.name + ' respawned!');
    });

    socket.on('disconnect', function () {
        if (util.findIndex(rooms[room].users, currentPlayer.id) > -1)
            rooms[room].users.splice(util.findIndex(rooms[room].users, currentPlayer.id), 1);
        console.log('[INFO] User ' + currentPlayer.name + ' disconnected from room '+ room +'!');

        io.to(room).emit('playerDisconnect', { name: currentPlayer.name });
    });

    socket.on('playerChat', function(data) {
        var _sender = data.sender.replace(/(<([^>]+)>)/ig, '');
        var _message = data.message.replace(/(<([^>]+)>)/ig, '');
        if (c.logChat === 1) {
            console.log('[CHAT] [' + (new Date()).getHours() + ':' + (new Date()).getMinutes() + '] ' + _sender + ': ' + _message);
        }
        io.to(room).emit('serverSendPlayerChat', {sender: _sender, message: _message.substring(0,35)});
    });

    socket.on('pass', function(data) {
        if (data[0] === c.adminPass) {
            console.log('[ADMIN] ' + currentPlayer.name + ' just logged in as an admin!');
            socket.emit('serverMSG', 'Welcome back ' + currentPlayer.name);
            io.to(room).emit('serverMSG', currentPlayer.name + ' just logged in as admin!');
            currentPlayer.admin = true;
        } else {
            
            // TODO: Actually log incorrect passwords.
              console.log('[ADMIN] ' + currentPlayer.name + ' attempted to log in with incorrect password.');
              socket.emit('serverMSG', 'Password incorrect, attempt logged.');
             pool.query('INSERT INTO logging SET name=' + currentPlayer.name + ', reason="Invalid login attempt as admin"');
        }
    });

    socket.on('kick', function(data) {
        if (currentPlayer.admin) {
            var reason = '';
            var worked = false;
            for (var e = 0; e < rooms[room].users.length; e++) {
                if (rooms[room].users[e].name === data[0] && !rooms[room].users[e].admin && !worked) {
                    if (data.length > 1) {
                        for (var f = 1; f < data.length; f++) {
                            if (f === data.length) {
                                reason = reason + data[f];
                            }
                            else {
                                reason = reason + data[f] + ' ';
                            }
                        }
                    }
                    if (reason !== '') {
                       console.log('[ADMIN] User ' + rooms[room].users[e].name + ' kicked successfully by ' + currentPlayer.name + ' for reason ' + reason);
                    }
                    else {
                       console.log('[ADMIN] User ' + rooms[room].users[e].name + ' kicked successfully by ' + currentPlayer.name);
                    }
                    socket.emit('serverMSG', 'User ' + rooms[room].users[e].name + ' was kicked by ' + currentPlayer.name);
                    rooms[room].sockets[rooms[room].users[e].id].emit('kick', reason);
                    rooms[room].sockets[rooms[room].users[e].id].disconnect();
                    rooms[room].users.splice(e, 1);
                    worked = true;
                }
            }
            if (!worked) {
                socket.emit('serverMSG', 'Could not locate user or user is an admin.');
            }
        } else {
            console.log('[ADMIN] ' + currentPlayer.name + ' is trying to use -kick but isn\'t an admin.');
            socket.emit('serverMSG', 'You are not permitted to use this command.');
        }
    });

    // Heartbeat function, update everytime.
    socket.on('0', function(target) {
        currentPlayer.lastHeartbeat = new Date().getTime();
        if (target.x !== currentPlayer.x || target.y !== currentPlayer.y) {
            currentPlayer.target = target;
        }
    });

    socket.on('1', function() {
        // Fire food.
        for(var i=0; i<currentPlayer.cells.length; i++)
        {
            if(((currentPlayer.cells[i].mass >= c.defaultPlayerMass + c.fireFood) && c.fireFood > 0) || (currentPlayer.cells[i].mass >= 20 && c.fireFood === 0)){
                var masa = 1;
                if(c.fireFood > 0)
                    masa = c.fireFood;
                else
                    masa = currentPlayer.cells[i].mass*0.1;
                currentPlayer.cells[i].mass -= masa;
                currentPlayer.massTotal -=masa;
                rooms[room].massFood.push({
                    id: currentPlayer.id,
                    num: i,
                    masa: masa,
                    hue: currentPlayer.hue,
                    target: {
                        x: currentPlayer.x - currentPlayer.cells[i].x + currentPlayer.target.x,
                        y: currentPlayer.y - currentPlayer.cells[i].y + currentPlayer.target.y
                    },
                    x: currentPlayer.cells[i].x,
                    y: currentPlayer.cells[i].y,
                    radius: util.massToRadius(masa),
                    speed: 25
                });
            }
        }
    });
    socket.on('2', function(virusCell) {
        function splitCell(cell) {
            if(cell.mass >= c.defaultPlayerMass*2) {
                cell.mass = cell.mass/2;
                cell.radius = util.massToRadius(cell.mass);
                currentPlayer.cells.push({
                    mass: cell.mass,
                    x: cell.x,
                    y: cell.y,
                    radius: cell.radius,
                    speed: 25
                });
            }
        }

        if(currentPlayer.cells.length < c.limitSplit && currentPlayer.massTotal >= c.defaultPlayerMass*2) {
            //Split single cell from virus
            if(virusCell) {
              splitCell(currentPlayer.cells[virusCell]);
            }
            else {
              //Split all cells
              if(currentPlayer.cells.length < c.limitSplit && currentPlayer.massTotal >= c.defaultPlayerMass*2) {
                  var numMax = currentPlayer.cells.length;
                  for(var d=0; d<numMax; d++) {
                      splitCell(currentPlayer.cells[d]);
                  }
              }
            }
            currentPlayer.lastSplit = new Date().getTime();
        }
    });
});

function tickPlayer(currentPlayer, room) {
    if(currentPlayer.lastHeartbeat < new Date().getTime() - c.maxHeartbeatInterval) {
        rooms[room].sockets[currentPlayer.id].emit('kick', 'Last heartbeat received over ' + c.maxHeartbeatInterval + ' ago.');
        rooms[room].sockets[currentPlayer.id].disconnect();
    }

    movePlayer(currentPlayer);

    function funcFood(f) {
        return SAT.pointInCircle(new V(f.x, f.y), playerCircle);
    }

    function deleteFood(f) {
        rooms[room].food[f] = {};
        rooms[room].food.splice(f, 1);
    }

    function eatMass(m) {
        if(SAT.pointInCircle(new V(m.x, m.y), playerCircle)){
            if(m.id == currentPlayer.id && m.speed > 0 && z == m.num)
                return false;
            if(currentCell.mass > m.masa * 1.1)
                return true;
        }
        return false;
    }

    function check(user) {
        for(var i=0; i<user.cells.length; i++) {
            if(user.cells[i].mass > 10 && user.id !== currentPlayer.id) {
                var response = new SAT.Response();
                var collided = SAT.testCircleCircle(playerCircle,
                    new C(new V(user.cells[i].x, user.cells[i].y), user.cells[i].radius),
                    response);
                if (collided) {
                    response.aUser = currentCell;
                    response.bUser = {
                        id: user.id,
                        name: user.name,
                        x: user.cells[i].x,
                        y: user.cells[i].y,
                        num: i,
                        mass: user.cells[i].mass
                    };
                    playerCollisions.push(response);
                }
            }
        }
        return true;
    }

    function collisionCheck(collision) {
        if (collision.aUser.mass > collision.bUser.mass * 1.1  && collision.aUser.radius > Math.sqrt(Math.pow(collision.aUser.x - collision.bUser.x, 2) + Math.pow(collision.aUser.y - collision.bUser.y, 2))*1.75) {
            console.log('[DEBUG] Killing user: ' + collision.bUser.id);
            console.log('[DEBUG] Collision info:');
            console.log(collision);

            var numUser = util.findIndex(rooms[room].users, collision.bUser.id);
            if (numUser > -1) {
                if(rooms[room].users[numUser].cells.length > 1) {
                    rooms[room].users[numUser].massTotal -= collision.bUser.mass;
                    rooms[room].users[numUser].cells.splice(collision.bUser.num, 1);
                } else {
                    rooms[room].users.splice(numUser, 1);
                    io.to(room).emit('playerDied', { name: collision.bUser.name });
                    rooms[room].sockets[collision.bUser.id].emit('RIP');
                }
            }
            currentPlayer.massTotal += collision.bUser.mass;
            collision.aUser.mass += collision.bUser.mass;
        }
    }

    for(var z=0; z<currentPlayer.cells.length; z++) {
        var currentCell = currentPlayer.cells[z];
        var playerCircle = new C(
            new V(currentCell.x, currentCell.y),
            currentCell.radius
        );

        var foodEaten = rooms[room].food.map(funcFood)
            .reduce( function(a, b, c) { return b ? a.concat(c) : a; }, []);

        foodEaten.forEach(deleteFood);

        var massEaten = rooms[room].massFood.map(eatMass)
            .reduce(function(a, b, c) {return b ? a.concat(c) : a; }, []);

        var virusCollision = rooms[room].virus.map(funcFood)
           .reduce( function(a, b, c) { return b ? a.concat(c) : a; }, []);

        if(virusCollision > 0 && currentCell.mass > rooms[room].virus[virusCollision].mass) {
          rooms[room].sockets[currentPlayer.id].emit('virusSplit', z);
          rooms[room].virus.splice(virusCollision, 1);
        }

        var masaGanada = 0;
        for(var m=0; m<massEaten.length; m++) {
            masaGanada += rooms[room].massFood[massEaten[m]].masa;
            rooms[room].massFood[massEaten[m]] = {};
            rooms[room].massFood.splice(massEaten[m],1);
            for(var n=0; n<massEaten.length; n++) {
                if(massEaten[m] < massEaten[n]) {
                    massEaten[n]--;
                }
            }
        }

        if(typeof(currentCell.speed) == "undefined")
            currentCell.speed = 6.25;
        masaGanada += (foodEaten.length * c.foodMass);
        currentCell.mass += masaGanada;
        currentPlayer.massTotal += masaGanada;
        currentCell.radius = util.massToRadius(currentCell.mass);
        playerCircle.r = currentCell.radius;

        tree.clear();
        rooms[room].users.forEach(tree.put);
        var playerCollisions = [];

        var otherUsers =  tree.get(currentPlayer, check);

        playerCollisions.forEach(collisionCheck);
    }
}

function moveloop() {
    for (let room in rooms) {
        for(let user in rooms[room].users) {
            tickPlayer(rooms[room].users[user], room);
        }
        for (let i=0; i < rooms[room].massFood.length; i++) {
            if(rooms[room].massFood[i].speed > 0) moveMass(rooms[room].massFood[i]);
        }
    }
}

function gameloop() {
    for(let room in rooms) {
        if (rooms[room].users.length > 0) {
            rooms[room].users.sort( function(a, b) { return b.massTotal - a.massTotal; });
            
            var topUsers = [];
            
            for (var i = 0; i < Math.min(10, rooms[room].users.length); i++) {
                if(rooms[room].users[i].type == 'player') {
                    topUsers.push({
                        id: rooms[room].users[i].id,
                        name: rooms[room].users[i].name
                    });
                }
            }
            if (isNaN(rooms[room].leaderboard) || rooms[room].leaderboard.length !== topUsers.length) {
                rooms[room].leaderboard = topUsers;
                rooms[room].leaderboardChanged = true;
            }
            else {
                for (i = 0; i < rooms[room].leaderboard.length; i++) {
                    if (rooms[room].leaderboard[i].id !== topUsers[i].id) {
                        rooms[room].leaderboard = topUsers;
                        rooms[room].leaderboardChanged = true;
                        break;
                    }
                }
            }
            for (i = 0; i < rooms[room].users.length; i++) {
                for(var z=0; z < rooms[room].users[i].cells.length; z++) {
                    if (rooms[room].users[i].cells[z].mass * (1 - (c.massLossRate / 1000)) > c.defaultPlayerMass && rooms[room].users[i].massTotal > c.minMassLoss) {
                        var massLoss = rooms[room].users[i].cells[z].mass * (1 - (c.massLossRate / 1000));
                        rooms[room].users[i].massTotal -= rooms[room].users[i].cells[z].mass - massLoss;
                        rooms[room].users[i].cells[z].mass = massLoss;
                    }
                }
            }
        }
        balanceMass(room);
    }
}

function sendUpdates() {
    for (let room in rooms) {
        rooms[room].users.forEach( function(u) {
            // center the view if x/y is undefined, this will happen for spectators
            u.x = u.x || c.gameWidth / 2;
            u.y = u.y || c.gameHeight / 2;
            
            var visibleFood  = rooms[room].food
            .map(function(f) {
                if ( f.x > u.x - u.screenWidth/2 - 20 &&
                    f.x < u.x + u.screenWidth/2 + 20 &&
                    f.y > u.y - u.screenHeight/2 - 20 &&
                    f.y < u.y + u.screenHeight/2 + 20) {
                        return f;
                    }
                })
                .filter(function(f) { return f; });
                
                var visibleVirus  = rooms[room].virus
                .map(function(f) {
                    if ( f.x > u.x - u.screenWidth/2 - f.radius &&
                        f.x < u.x + u.screenWidth/2 + f.radius &&
                        f.y > u.y - u.screenHeight/2 - f.radius &&
                        f.y < u.y + u.screenHeight/2 + f.radius) {
                            return f;
                        }
                    })
                    .filter(function(f) { return f; });
                    
                    var visibleMass = rooms[room].massFood
                    .map(function(f) {
                        if ( f.x+f.radius > u.x - u.screenWidth/2 - 20 &&
                            f.x-f.radius < u.x + u.screenWidth/2 + 20 &&
                            f.y+f.radius > u.y - u.screenHeight/2 - 20 &&
                            f.y-f.radius < u.y + u.screenHeight/2 + 20) {
                                return f;
                            }
                        })
                        .filter(function(f) { return f; });
                        
                        var visibleCells  = rooms[room].users
                        .map(function(f) {
                            for(var z=0; z<f.cells.length; z++)
                            {
                                if ( f.cells[z].x+f.cells[z].radius > u.x - u.screenWidth/2 - 20 &&
                                    f.cells[z].x-f.cells[z].radius < u.x + u.screenWidth/2 + 20 &&
                                    f.cells[z].y+f.cells[z].radius > u.y - u.screenHeight/2 - 20 &&
                                    f.cells[z].y-f.cells[z].radius < u.y + u.screenHeight/2 + 20) {
                                        z = f.cells.lenth;
                                        if(f.id !== u.id) {
                                            return {
                                                id: f.id,
                                                x: f.x,
                                                y: f.y,
                                                cells: f.cells,
                                                massTotal: Math.round(f.massTotal),
                                                hue: f.hue,
                                                name: f.name
                                            };
                                        } else {
                                            //console.log("Nombre: " + f.name + " Es Usuario");
                                            return {
                                                x: f.x,
                                                y: f.y,
                                                cells: f.cells,
                                                massTotal: Math.round(f.massTotal),
                                                hue: f.hue,
                                            };
                                        }
                                    }
                                }
                            })
                            .filter(function(f) { return f; });
                            
                            rooms[room].sockets[u.id].emit('serverTellPlayerMove', visibleCells, visibleFood, visibleMass, visibleVirus);
                            if (rooms[room].leaderboardChanged) {
                                rooms[room].sockets[u.id].emit('leaderboard', {
                                    players: rooms[room].users.length,
                                    leaderboard: rooms[room].leaderboard
                                });
                            }
                        });
                        rooms[room].leaderboardChanged = false;
    }
}

setInterval(moveloop, 1000 / 60);
setInterval(gameloop, 1000);
setInterval(sendUpdates, 1000 / c.networkUpdateFactor);

// Don't touch, IP configurations.
var ipaddress = process.env.OPENSHIFT_NODEJS_IP || process.env.IP || c.host;
var serverport = process.env.OPENSHIFT_NODEJS_PORT || process.env.PORT || c.port;
http.listen( serverport, ipaddress, function() {
    console.log('[DEBUG] Listening on ' + ipaddress + ':' + serverport);
});
