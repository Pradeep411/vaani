/* Vaani x CGotchi: a steady 250 ms tick from a worker. Timers in a hidden tab are slowed to once a minute after 5 minutes;
   a dedicated worker's are not, so the CGotchi remote keeps working while Vaani sits in a background tab. */
setInterval(function () { postMessage(0); }, 250);
