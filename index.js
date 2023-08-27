/*
  This file conforms to the standardJS style (https://standardjs.com/)
  This file is licensed under the GNU GPLv3 license (https://www.gnu.org/licenses/gpl-3.0.en.html)
*/

'use strict'
var request = require('request') // makes HTTP requests
const errHandler = require('./errPresets.js') // reqjs-err-handler error presets
const EventEmitter = require('events') // emit 'ready' event
const { response } = require('express')
const { parse } = require('path')

var meta = {
  version: '2.0.0',
  github: 'qwazwsx/infinite-campus'
}

/*
  Heres some basic vocab used to keep things consistent throughout naming and comments
  term: a way of dividing up the school year. This may be by quarters, trimesters, semesters, etc.
  course: a class
  placement: the time within a day/term that a course takes place. Ex: 2nd hour at 9:15AM during quarter 1
  notification count: the number of unseen notifications. This is the number that shows next to the bell icon on the website. The count is reset when you click the bell. NOTE: unseen is different from unread
  (un)read notification: individual read state of a single notification. NOTE: read state is different from the unseen count
*/

class User extends EventEmitter {
  /**
   * Fired when the user is authenticated and ready to make API calls
   * @event User#ready
   */

  /**
   * Fired when the login process has failed
   * @event User#error
   */

  /**
    * Authenticates a user. Fires [ready]{@link User#event:ready} event when the user is logged in
    * ##### Example: <br>
    * <pre><code class="prettyprint">const InfiniteCampus = require('infinite-campus')
    * const user = new InfiniteCampus('New York District', 'NY', 'JDoe12', 'XXXXXX')
    *
    * user.on('ready', () => {
    *   // user is authenticated, now we can make API calls
    * })</code></pre>
    * @param {string} districtName - the name of the district the user belongs to (ex: 'New York School Districts', 'New York')
    * @param {string} state - two letter state code ('NY', 'MN')
    * @param {username} - the user's username
    * @param {password} - the user's password
    * @fires User#ready
    * @async

  */

  constructor(districtName, state, username, password) {
    super() // calls EventEmitter constructor
    this.meta = meta
    this.authenticated = false
    this.cookies = request.jar()
    request = request.defaults({
      jar: this.cookies,
      headers: {
        'User-Agent': `GitHub ${meta.github} - v${meta.version}`,
        'Accept': 'application/json'
      }
    })

    // detect login errors thrown
    // if there is a listener on 'error' event, emit it, else throw the error and kill the process
    this.on('error', (err) => {
      if (!this.hasErrorListener) {
        throw err
      }
    })

    // check to see if anybody is listening on 'error'
    this.hasErrorListener = false
    this.once('newListener', (event) => {
      if (event === 'error') {
        this.hasErrorListener = true
      }
    })

    // fetch district info & log in
    this._getDistrict(districtName, state).then(() => {
      // weird return promise to avoid minor callback hell
      return this._login(username, password)
    }).then(() => {
      // once we are logged in
      this.authenticated = true
      this.emit('ready', this)
    }).catch((err) => {
      // this error should never actually get thrown
      // if it does, it means either 1.) the API has changed and we cant parse it 2.) there is some unexpected value and it broke with my code
      throw Error('Unknown error during the getDistrict/login process. If you keep getting this error please submit an issue on GitHub @' + meta.github + '\n ' + err)
    })
  }

  /**
    * fetches information about a school district thats needed to make requests
    * this data is stored in the this.district object
    * @param {string} districtName - the name of the district the user belongs to (ex: 'New York School Districts', 'New York')
    * @param {string} state - two letter state code (ex: 'NY', 'MN')
    * @async
    * @private

  */
  _getDistrict(districtName, state) {
    return new Promise((resolve, reject) => {
      request('https://mobile.infinitecampus.com/mobile/searchDistrict?query=' + districtName + '&state=' + state, (err, res, body) => {
        try {
          errHandler.district.handle(err, res, body)
        } catch (err) {
          return this.emit('error', err)
        }

        this.district = JSON.parse(body).data[0]
        resolve()
      })
    })
  }

  /**
   * logs a user in
   * cookies get stored as a requestJS cookie jar in this.cookies
   * @param {string} username - a user's username
   * @param {string} password - a user's password
   * @async
   * @private
   */
  _login(username, password) {
    return new Promise((resolve, reject) => {
      if (this.district === undefined) {
        throw Error('._getDistrict() must be ran before you can log in.')
      }

      request(this.district.district_baseurl + 'verify.jsp?nonBrowser=true&username=' + username + '&password=' + password + '&appName=' + this.district.district_app_name, (err, res, body) => {
        try {
          errHandler.login.handle(err, res, body)
        } catch (err) {
          return this.emit('error', err)
        }

        resolve()
      })
    })
  }

  //bit of a mess, but it works
  /*
    Pulls the following data relating to the student:
    - courses
    - grades
    - attendance
    - assignments
    - term details
  */
  getCourses(schoolID) {
    return new Promise((resolve, reject) => {
      checkAuth.call(this)

      // fetch roster with placements
      request(this.district.district_baseurl + 'resources/portal/roster?_expand=%7BsectionPlacements-%7Bterm%7D%7D', (err, res, body) => {
        errHandler.generic200.handle(err, res, body)
        let roster = JSON.parse(body)

        // fetch grades
        request(this.district.district_baseurl + 'resources/portal/grades', (err, res, body) => {
          errHandler.generic200.handle(err, res, body)
          let data = JSON.parse(body)

          let result = [] // object that we return later
          let crossReference = {}

          let schoolIndex = 0;

          if (data.length > 1) {
            let schools = []
            data.forEach((school) => {
              schools.push({
                schoolName: school.displayName,
                id: school.schoolID,
                numberOfTerms: school.terms.length,
                totalNumberOfCourses: school.courses.length
              })
            })

            // throw warning is schoolID isn't specifed
            if (schoolID === undefined) {
              console.warn(`WARNING: You are enrolled in ${data.length} schools, please explicitly specify a school ID to fetch courses from. Please see the below output to see which schoolID to use. (Defaulting to the first school returned by I.C. API - name: '${schools[0].schoolName}' - id: ${schools[0].id})`, schools)
              // default to first in array
              schoolIndex = 0
            } else {
              // find index from schoolID
              data.forEach((school, i) => {
                if (school.schoolID == schoolID) {
                  schoolIndex = i
                }
              })
              if (schoolIndex === undefined) {
                throw new Error(`Supplied schoolID in getCourses() does not exist, please select from the following list \n\n ${JSON.stringify(schools)}\n\n`)
              }
            }

          }

          // loop over terms from grades
          data[schoolIndex].terms.forEach((term, i) => {
            let termResult = {
              name: term.termName,
              seq: term.termSeq,
              startDate: term.startDate,
              endDate: term.endDate,
              courses: []
            }

            // loop over classes in a term
            term.courses.forEach((course, ii) => {
              //i represents quarter/term, ii represents class in that term
              let grade = course.gradingTasks[1]

              let courseResult = {
                name: course.courseName,
                courseNumber: course.courseNumber,
                roomName: course.roomName,
                teacher: course.teacherDisplay,
                // seq: null, // set this to null so we can add placement data later
                grades: {
                  score: (grade.progressScore !== undefined) ? grade.progressScore : grade.score,
                  percent: (grade.progressPercent !== undefined) ? grade.progressPercent : grade.percent,
                  totalPoints: (grade.progressTotalPoints !== undefined) ? grade.progressTotalPoints : grade.totalPoints,
                  pointsEarned: (grade.progressPointsEarned !== undefined) ? grade.progressPointsEarned : grade.pointsEarned
                },
                assignments: [
                ],
                attendance: {
                },
                comments: grade.comments,
                _id: course.sectionID
              }

              // remove grades for courses without grades
              if (!(grade.progressScore || grade.score) &&
                !(grade.progressPercent || grade.percent) &&
                !(grade.progressTotalPoints || grade.totalPoints) &&
                !(grade.progressPointsEarned || grade.pointsEarned)) courseResult.grades = undefined;

              // push class to term array
              termResult.courses.push(courseResult)

              // setup cross reference with a pointer into the result var
              // we can cross reference the data from both endpoints by using the class ID later
              crossReference[course._id] = {
                i: i,
                ii: ii
              }
            })

            // push terms to final array
            //console.log(termResult)
            result.push(termResult)
          })

          /*
            At this point we have basic info about terms and a bit data on the classes (name, teacher, grade). But we don't have any placement data (period, start & end time, sequence data) for courses or for terms.
            So now we look over the data from the /roster endpoint and use our cross reference object to add the missing data. We loop over the data (an array of courses) and check the class ID with our cross reference.
            That gives us a pointer into the result array so we can add the data in. We add class placement data into courses and check to see if we need to add term data (this is because the term object is included in every course)
          */

          // loop over classes from /roster
          roster.forEach((course, i) => {
            let placement = course.sectionPlacements[0]

            // find course from cross reference
            let ref = crossReference[roster[i]._id]
            if (!ref) return
            let target = result[ref.i].courses[ref.ii]

            // add placement data
            target.placement = {
              periodName: placement.periodName,
              periodSeq: placement.periodSequence,
              startTime: placement.startTime,
              endTime: placement.endTime
            }

            // // if the term doesn't have placement data associated with it
            // if (result[ref.i].seq == null) {
            //   console.log('AAA')
            //   let term = result[ref.i]
            //   term.seq = placement.term.seq
            //   term.startDate = placement.term.startDate
            //   term.endDate = placement.term.endDate
            // }
          })

          request(this.district.district_baseurl + 'api/portal/students', (err, res, body) => {
            errHandler.generic200.handle(err, res, body)
            let data = JSON.parse(body)
    
            let enrollmentID = data[0].enrollments[0].enrollmentID
            
            request(this.district.district_baseurl + `resources/portal/attendance/${enrollmentID}?courseSummary=true`, (err, res, body) => {
              errHandler.generic200.handle(err, res, body)
              let data = JSON.parse(body)

              for (var i = 0; i < data.terms.length; i++) { // term
                for (var j = 0; j < data.terms[i].courses.length; j++) { // courses
                  let attendanceData = {
                    absences: data.terms[i].courses[j].absentList.length,
                    tardies: data.terms[i].courses[j].tardyList.length,
                  }

                  result[i].courses[j].attendance = attendanceData
                }
              }
            })
          })

          //before we resolve, we must add assignment data to each course
          //go through each array element of result and examine start/enddate. if the current date is between the start and end date, then we need to move our index to that element
          //then, we need to make a request to the assignments api for that course
          
          var ids = []

          for (var i = 0; i < result.length; i++) {
            let currentDate = new Date()
            let startDate = new Date(result[i].startDate)
            let endDate = new Date(result[i].endDate)
            if (currentDate >= startDate && currentDate <= endDate) {
              //we are in the correct term
              for (var j = 0; j < result[i].courses.length; j++) {
                ids.push(result[i].courses[j]._id)
              }
              break;
            }
          }

          console.log(ids)

          for (var i = 0; i < ids.length; i++) {
            request(this.district.district_baseurl + `resources/portal/grades/detail/${ids[i]}?showAllTerms=true`, (err, res, body) => {
              errHandler.generic200.handle(err,res,body)
              let data = JSON.parse(body)
              let assignments = []

              let assignmentIndex = 0
              data.details.forEach((element) => {
                if (element.categories.length > 0) {
                  console.log("element has assignments")
                  
                  element.categories.forEach((category) => {
                    category.assignments.forEach((assignment) => {
                      let assignmentResult = {
                        _idTerm: assignment.sectionID,
                        _id: assignmentIndex,
                        termSeq: element.task.termSeq,
                        category: category.name,
                        weight: parseFloat(category.weight),
                        name: assignment.assignmentName,
                        assigned: assignment.assignedDate,
                        due: assignment.dueDate,
                        gradedDate: assignment.scoreModifiedDate,
                        score: parseFloat(assignment.score),
                        earnedPoints: parseFloat(assignment.scorePoints),
                        totalPoints: parseFloat(assignment.totalPoints),
                        missing: assignment.missing,
                        late: assignment.late,
                        isGraded: !assignment.notGraded
                      }
  
                      assignmentIndex++
                      assignments.push(assignmentResult)
                    })
                  })
                }
              })

              for (var j = 0; j < assignments.length; j++) {
                for (var k = 0; k < result[assignments[j].termSeq - 1].courses.length; k++) {
                  if (assignments[j]._idTerm == result[assignments[j].termSeq - 1].courses[k]._id) {
                    result[assignments[j].termSeq - 1].courses[k].assignments = assignments
                  }
                }
              }
            })
          }

          

          resolve(result)
        })
      })
    })
  }

  /**
   * gets current number of unseen notifications <br>
   * *note: the unseen notification count is different from the read status of an individual notification*
   * @async
   * @returns {integer} number of unseen notifications
   * @example
   * const InfiniteCampus = require('infinite-campus')
   * const user = new InfiniteCampus('New York District', 'NY', 'JDoe12', 'XXXXXX')
   *
   * // wait until we are done logging in
   * user.on('ready', () => {
   *   // now that we are logged in, get the notification count
   *   user.getNotificationCount().then((count) => {
   *     console.log(count) // returns: 7
   *   })
   * })
   *
   */
  getNotificationCount() {
    return new Promise((resolve, reject) => {
      checkAuth.call(this)
      request(this.district.district_baseurl + 'prism?x=notifications.NotificationUser-countUnviewed', (err, res, body) => {
        errHandler.generic200.handle(err, res, body)
        resolve(parseInt(JSON.parse(body).data.RecentNotifications.count))
      })
    })
  }

  /**
   * resets the unseen notification count. This is what happens when you click on the bell icon in Infinite Campus <br>
   * *note: this is different from the read status of individual notifications, see [User.markAllNotificationsRead()]{@link User#markAllNotificationsRead} and [Notification.toggleRead()]{@link Notification#toggleRead}*
   * @async
   * @example
   * const InfiniteCampus = require('infinite-campus')
   * const user = new InfiniteCampus('New York District', 'NY', 'JDoe12', 'XXXXXX')
   *
   * // wait until we are done logging in
   * user.on('ready', () => {
   *   // now that we are logged in, reset the notification count
   *   user.resetNotificationCount().then(() => {
   *     // ...
   *   })
   * })
   *
   */
  resetNotificationCount() {
    return new Promise((resolve, reject) => {
      checkAuth.call(this)
      request(this.district.district_baseurl + 'prism?x=notifications.NotificationUser-updateLastViewed', (err, res, body) => {
        errHandler.generic200.handle(err, res, body)
        resolve()
      })
    })
  }

  /**
   * marks all notifications as read <br>
   * *note: this is different from the unread count, see [User.getNotificationCount()]{@link User#getNotificationCount} and [User.resetNotificationCount()]{@link User#resetNotificationCount}*
   * @async
   * @example
   * const InfiniteCampus = require('infinite-campus')
   * const user = new InfiniteCampus('New York District', 'NY', 'JDoe12', 'XXXXXX')
   *
   * // wait until we are done logging in
   * user.on('ready', () => {
   *   // now that we are logged in, mark all notifications as read
   *   user.markAllNotificationsRead().then(() => {
   *     // ...
   *   })
   * })
   *
   */
  markAllNotificationsRead() {
    return new Promise((resolve, reject) => {
      checkAuth.call(this)
      request(this.district.district_baseurl + 'prism?x=notifications.Notification-markAllRead', (err, res, body) => {
        errHandler.generic200.handle(err, res, body)
        resolve()
      })
    })
  }

  /**
   * toggles a given notifications read state
   * *note: this is different from the unread count, see [User.getNotificationCount()]{@link User#getNotificationCount} and [User.resetNotificationCount()]{@link User#resetNotificationCount}* <br>
   * this function is included in {@link Notification}. For readability this function is private and a dock
   * @async
   * @private
   */
  _toggleNotificationRead(id) {
    return new Promise((resolve, reject) => {
      checkAuth.call(this)
      request(this.district.district_baseurl + 'prism?x=notifications.Notification-toggleRead&notificationID=' + id, (err, res, body) => {
        errHandler.generic200.handle(err, res, body)
        resolve()
      })
    })
  }

  /**
   * Returns a list of notifications. <br>
   * ###### notification types: <br>
   * keep in mind mind that that this data may not be 100% accurate, more research needs to be done <br>
   * * 2 - attendance updated (eg. you get marked tardy) <br>
   * * 3 - course grade updated (eg. your class grade changes after an assignment is graded) <br>
   * * 4 - assignment updated (eg. an assignment is graded or its state is updated as missing, late, etc )
   * @async
   * @param {integer} [limit=200] - number of notifications to return
   * @returns {Notification[]} array of notifications
   * @example
   * // this example will mark all notifications before certain date as read
   *
   * // first we log in
   * const InfiniteCampus = require('infinite-campus')
   * const user = new InfiniteCampus('New York District', 'NY', 'JDoe12', 'XXXXXX')
   *
   * // wait until we are done logging in
   * user.on('ready', () => {
   *   // now that we are logged in, get notifications
   *   user.getNotifications().then((notifications) => {
   *     console.log(notifications)
   *   })
   * })
   *
   */
  getNotifications(limit) {
    return new Promise((resolve, reject) => {
      checkAuth.call(this)

      if (typeof limit !== 'number') {
        throw new Error(`[User.getNotifications(${limit})] 'limit' argument must be a number, got '${typeof limit}'`)
      }
      // if limit isn't set, default to 200
      limit = limit === undefined ? 200 : limit
      request(this.district.district_baseurl + 'prism?x=notifications.Notification-retrieve&limitCount=' + limit, (err, res, body) => {
        errHandler.generic200.handle(err, res, body)
        // console.log(body)
        body = JSON.parse(body).data.NotificationList.Notification

        let result = []

        // loop over every assignment
        body.forEach((notification) => {
          result.push({
            id: notification.notificationID,
            text: notification.notificationText,
            timestamp: new Date(notification.creationTimestamp).getTime() / 1000, // convert text to unix ms to s
            timestampText: notification.displayedDate,
            type: notification.notificationTypeID,
            link: this.district.district_baseurl + notification.linkUrl + notification.linkContext,
            read: (notification.read === 'true'),
            toggleRead: () => {
              this._toggleNotificationRead(notification.notificationID)
            }
          })
        })

        resolve(result)
      })
    })
  }
}

/**
 * helper function to make sure a user is authenticated before making API calls
 * @private
 */
function checkAuth() {
  // checks if the user has been authenticated
  if (!this.authenticated || this.district === undefined) {
    throw Error('User isn\'t authenticated yet. Please use the .on(\'ready\') event emitted by the User class. For help please see the example code on GitHub: https://github.com/' + meta.github)
  }
}

module.exports = User

// debugging:
// keep debugger alive
// setInterval(() => { console.log('keep alive') }, 100000000)

// this is just plain stupid:
// process.on('uncaughtException', function (err) {
//   console.log('Caught exception: ' + err)
// })