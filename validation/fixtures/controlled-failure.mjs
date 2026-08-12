#!/usr/bin/env node

console.log('Authorization: Bearer fixture-token-do-not-keep');
console.log('cookie=session=fixture-cookie-do-not-keep');
console.error('fixture failure at /Users/example/private/project targetId=ABCDEF012345 port=49321 pid=4242');
process.exitCode = 23;
