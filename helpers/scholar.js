'use strict'
const { Article, Publishcation } = require('../models')
const gsCrawlQueue = require('../job/queue');
const {
  GOOGLE_SCHOLAR_URL,
  GOOGLE_SCHOLAR_PROFILE_URL,
  GOOGLE_SCHOLAR_URL_PREFIX
} = require('../consts.js');
let scholar = (function () {
  
  let request = require('request')
  let cheerio = require('cheerio')
  let striptags = require('striptags')
  const throttledQueue = require('throttled-queue')
  const RateLimiter = require('limiter').RateLimiter;

  // 1 per 200 ms ~= 5/s per
  // https://developers.google.com/webmaster-tools/search-console-api-original/v3/limits
  const secondLimiter = new RateLimiter({
    tokensPerInterval: 1,
    interval: 'second'
  });
  const minuteLimiter = new RateLimiter({
    tokensPerInterval: 60,
    interval: 'minute'
  });

  const perSecThrottle = throttledQueue(5, 1000)
  const perMinThrottle = throttledQueue(200, 60 * 1000)
  const RESULTS_PER_PAGE = 10

  const ELLIPSIS = '...';
  const ELLIPSIS_HTML_ENTITY = '&#x2026;'
  const COMMA = ',';
  const COMMA_HTML_ENTITY = '&#xFFFD;'
  const ET_AL_NAME = 'et al.'
  const CITATION_COUNT_PREFIX = 'Cited by '
  const RELATED_ARTICLES_PREFIX = 'Related articles'

  const STATUS_CODE_FOR_RATE_LIMIT = 503
  const STATUS_MESSAGE_FOR_RATE_LIMIT = 'Service Unavailable'
  const STATUS_MESSAGE_BODY = 'This page appears when Google automatically detects requests coming from your computer network which appear to be in violation of the <a href="//www.google.com/policies/terms/">Terms of Service</a>. The block will expire shortly after those requests stop.'

  // regex with thanks to http://stackoverflow.com/a/5917250/1449799
  const RESULT_COUNT_RE = /\W*((\d+|\d{1,3}(,\d{3})*)(\.\d+)?) results/
  
  function verifyRequest(error, response) {
    if (error) {
      return error;
    } 
    console.log(`verifyRequesttt ${response.statusCode} - ${response.statusMessage}`);
    if (response.statusCode !== 200) {
      if (
            response.statusCode === STATUS_CODE_FOR_RATE_LIMIT 
        &&  response.statusMessage === STATUS_MESSAGE_FOR_RATE_LIMIT 
        &&  response.body.indexOf(STATUS_MESSAGE_BODY) > -1
      ) {
        return new Error('You are being rate-limited by google. you have made too many requests too quickly. see: https://support.google.com/websearch/answer/86640');
      }
      console.log('response status code: ' + response.statusCode + ' - ' + response.statusMessage);
      return new Error('response status code: ' + response.statusCode + ' - ' + response.statusMessage);
    } 
  }

  async function promiseRequest(requestOptions) {
    await minuteLimiter.removeTokens(1);
    await secondLimiter.removeTokens(1);
    return new Promise((resolve, reject) => {
      request(requestOptions, function(error, response, html) {
        let err = verifyRequest(error, response)
        if (!err) {
          resolve(html);
        }
        else reject(err);
      });
    });
  }
  function parseCitationHtml(citationLink, html) {
    let $2 = cheerio.load(html);
    let SELECTOR_OCI_TABLE_ROW = '#gsc_oci_table .gs_scl';
    let rows = $2(SELECTOR_OCI_TABLE_ROW);
    let data = {};
    data.citedUrl = GOOGLE_SCHOLAR_URL_PREFIX + citationLink;
    let title = $2('#gsc_oci_title');
    data.title = title.text();
    if (!data.title || !data.title.length) {
      console.log('====' ,$2('#gsc_oci_title').html());
    }
    for (let i = 0; i < rows.length; i++) {
      let field = $2(rows[i]).find('.gsc_oci_field').text().trim().toLowerCase().replace(/\s+/g, "_");
      let value = $2(rows[i]).find('.gsc_oci_value').text().trim();
      switch(field) {
      case 'total_citations':
        value = $2(rows[i]).find('.gsc_oci_value > div > a').text().trim().replace('Cited by ','');
        data[field] = value;
        break;
      case 'authors':
        data[field] = value.split(/\s*,\s*/);
        break;
      case 'inventors':
        data['authors'] = value.split(/\s*,\s*/);
        data['publisher'] = 'Patent';
        data['venue'] = 'Patent';
        break;
      case 'description':
        break;
      default: 
        data[field] = value;
        break;
      }
    }
    return data;
  }
  function processHtml(html, user, yearWindow = -1) {
    let $ = cheerio.load(html)
    const SELECTOR_CITATION_A = '#gsc_a_t .gsc_a_tr .gsc_a_t a'
    const SELECTOR_CITATION_Y = '#gsc_a_t .gsc_a_tr .gsc_a_y span'
    let citations = $(SELECTOR_CITATION_A);
    let years = $(SELECTOR_CITATION_Y);
    let currentYear = new Date().getFullYear();
    console.log('processHtml', yearWindow, currentYear);
    for (let i = 0; i < citations.length; i++) {
      if (yearWindow < 0) {
        let citationLink = $(citations[i]).attr('href');
        gsCrawlQueue.add({
          type: 1,
          citationLink,
          user
        });
      }
      else {
        let y = parseInt($(years[i]).text());
        console.log('y: ', y, $(years[i]).text());
        if (y >= currentYear - yearWindow) {
          let citationLink = $(citations[i]).attr('href');
          gsCrawlQueue.add({
            type: 1,
            citationLink,
            user
          });
        }
      }
    }
    return citations.length;
  }
  function processHtml1(html, RESULTS_TAG, TITLE_TAG, AUTHOR_NAMES_TAG, FOOTER_LINKS_TAG) {
    let $ = cheerio.load(html)
        
    let results = $(RESULTS_TAG)
    let resultCount = 0
    
    let processedResults = []
    for (let r of results) {
      let title = $(r).find(TITLE_TAG).text().trim()
      let authorNamesHTMLString = $(r).find(AUTHOR_NAMES_TAG).html()
      let etAl = false
      let etAlBegin = false
      let authors = []
      let footerLinks = $(r).find(FOOTER_LINKS_TAG)
      let citedCount = 0
      let citedUrl = ''
      
      // Profile specific
      let year = $(r).find('.gsc_a_y').text()
      $(r).find('.gs_gray').last().find('.gs_oph').remove()
      let venueHTMLString = $(r).find('.gs_gray').last().html()
      let venue;
      
      if ($(footerLinks[0]).text().indexOf(CITATION_COUNT_PREFIX) >= 0) {
        citedCount = $(footerLinks[0]).text().substr(CITATION_COUNT_PREFIX.length)
      }
      if ($(footerLinks[0]).attr &&
        $(footerLinks[0]).attr('href') &&
        $(footerLinks[0]).attr('href').length > 0) {
        citedUrl = GOOGLE_SCHOLAR_URL_PREFIX + $(footerLinks[0]).attr('href')
      }
      
      if (footerLinks &&
        footerLinks.length &&
        footerLinks.length > 0) {
        // Relax restrictions as no 'Cited by' prefix on author page.
          citedCount = $(footerLinks[0]).text();
          if ($(footerLinks[0]).text &&
            $(footerLinks[0]).text().indexOf(CITATION_COUNT_PREFIX) >= 0) {
            citedCount = $(footerLinks[0]).text().substr(CITATION_COUNT_PREFIX.length)
          }

        if ($(footerLinks[1]).text &&
          $(footerLinks[1]).text().indexOf(RELATED_ARTICLES_PREFIX) >= 0 &&
          $(footerLinks[1]).attr &&
          $(footerLinks[1]).attr('href') &&
          $(footerLinks[1]).attr('href').length > 0) {
        }
      }
      if (authorNamesHTMLString) {
        let cleanString = authorNamesHTMLString;
        
        // Check also for non-HTML ellipsis.
        removeFromEnd(cleanString, ELLIPSIS_HTML_ENTITY, function(resultA, stringA) { 
            removeFromEnd(cleanString, ELLIPSIS, function(resultB, stringB) {
                if ( resultA ) {
                  cleanString = stringA;
                } else if ( resultB ) {
                cleanString = stringB;
              } else if ( resultA || resultB ) {
                etAl = true; 
              }
              });
          });
        
        removeFromBeginning(cleanString, ELLIPSIS_HTML_ENTITY, function(resultA, stringA) { 
          removeFromBeginning(cleanString, ELLIPSIS, function(resultB, stringB) {
            if ( resultA ) {
              cleanString = stringA;
            } 
            else if ( resultB ) {
              cleanString = stringB;
            } 
            else if ( resultA || resultB ) {
              etAlBegin = true; 
            }
          });
        });
        
        let htmlAuthorNames = cleanString.split(', ')
        if (etAl) {
          htmlAuthorNames.push(ET_AL_NAME)
        }
        if (etAlBegin) {
          htmlAuthorNames.unshift(ET_AL_NAME)
        }
        authors = htmlAuthorNames.map(name => {
          let tmp = cheerio.load(name)
          let authorObj = {
            name: '',
            url: ''
          }
          if (tmp('a').length === 0) {
            authorObj.name = striptags(name)
          } else {
            authorObj.name = tmp('a').text()
            authorObj.url = GOOGLE_SCHOLAR_URL_PREFIX + tmp('a').attr('href')
          }
          return authorObj
        })
      }
      
      // Profile specific.
      if ( venueHTMLString ) {
          
        venue = venueHTMLString;
        
        removeFromEnd(venue, ELLIPSIS_HTML_ENTITY, function(resultA, stringA) {
          removeFromEnd(venue, ELLIPSIS, function(resultB, stringB) {
            if ( resultA ) {
              venue = stringA;
            } else if ( resultB ) {
              venue = stringB;
            }
            removeFromEnd(venue, COMMA_HTML_ENTITY, function(resultC, stringC) { 
              removeFromEnd(venue, COMMA, function(resultD, stringD) {
                if ( resultC ) {
                    venue = stringC;
                  } else if ( resultD ) {
                  venue = stringD;
                }
              });
            });
          });
        });
      }
      
      processedResults.push({
        title: title,
        url: url,
        authors: authors,
        citedCount: citedCount,
        citedUrl: citedUrl,
        year: year,
        venue: venue
      });
      
    }
    
    let resultsCountString = $('#gs_ab_md').text()
    if (resultsCountString && resultsCountString.trim().length > 0) {
      let matches = RESULT_COUNT_RE.exec(resultsCountString)
      if (matches && matches.length > 0) {
        resultCount = parseInt(matches[1].replace(/,/g, ''))
      } else {
        resultCount = processedResults.length
      }
    } else {
      resultCount = processedResults.length
    }

    resolve({
      results: processedResults,
      count: resultCount,
    })
  }

  function responseAction(error, response, reject, html, callback) {
    if (error) {
      reject(error)
    } else if (response.statusCode !== 200) {
      if (
            response.statusCode === STATUS_CODE_FOR_RATE_LIMIT 
        &&  response.statusMessage === STATUS_MESSAGE_FOR_RATE_LIMIT 
        &&  response.body.indexOf(STATUS_MESSAGE_BODY) > -1
      ) {
        reject(new Error('You are being rate-limited by google. you have made too many requests too quickly. see: https://support.google.com/websearch/answer/86640'))
      } 
      else {
        reject(new Error('expected statusCode 200 on http response, but got: ' + response.statusCode))
      }
    } else {
      callback(html);
    }
  }
  
  function removeFromEnd(string, remove, callback) {
	if (string.substr(string.length - remove.length) === remove) {
      callback(true, string.substr(0, string.length - remove.length));
    } else {
    	  callback(false, string);
    }
  }
  
  function removeFromBeginning(string, remove, callback) {
	if (string.substr(0, remove.length) === remove) {
      callback(true, string.substr(remove.length + 2));
    } else {
    	  callback(false, string);
    }
  }
  
  function scholarResultsCallback(resolve, reject, RESULTS_TAG, TITLE_TAG, URL_TAG, AUTHOR_NAMES_TAG, FOOTER_LINKS_TAG) {
    return function (error, response, html) {
      responseAction(error, response, reject, html, function callback(html) {
        let $ = cheerio.load(html)
    	      
	      let results = $(RESULTS_TAG)
	      let resultCount = 0
	      let nextUrl = ''
	      let prevUrl = ''
	      if ($('.gs_ico_nav_next').parent().attr('href')) {
	        nextUrl = GOOGLE_SCHOLAR_URL_PREFIX + $('.gs_ico_nav_next').parent().attr('href')
	      }
	      if ($('.gs_ico_nav_previous').parent().attr('href')) {
	        prevUrl = GOOGLE_SCHOLAR_URL_PREFIX + $('.gs_ico_nav_previous').parent().attr('href')
	      }
	      
	      let processedResults = []
	      results.each((i, r) => {
	        let title = $(r).find(TITLE_TAG).text().trim()
	        let url = $(r).find(URL_TAG).attr('href')
	        let authorNamesHTMLString = $(r).find(AUTHOR_NAMES_TAG).html()
	        let etAl = false
	        let etAlBegin = false
	        let authors = []
	        let description = $(r).find('.gs_ri .gs_rs').text()
	        let footerLinks = $(r).find(FOOTER_LINKS_TAG)
	        let citedCount = 0
	        let citedUrl = ''
	        let relatedUrl = ''
	        
	        // Profile specific
	        let year = $(r).find('.gsc_a_y').text()
	        $(r).find('.gs_gray').last().find('.gs_oph').remove()
	        let venueHTMLString = $(r).find('.gs_gray').last().html()
	        let venue;
	        
	        if ($(footerLinks[0]).text().indexOf(CITATION_COUNT_PREFIX) >= 0) {
	          citedCount = $(footerLinks[0]).text().substr(CITATION_COUNT_PREFIX.length)
	        }
	        if ($(footerLinks[0]).attr &&
	          $(footerLinks[0]).attr('href') &&
	          $(footerLinks[0]).attr('href').length > 0) {
	          citedUrl = GOOGLE_SCHOLAR_URL_PREFIX + $(footerLinks[0]).attr('href')
	        }
	        
	        if (footerLinks &&
	          footerLinks.length &&
	          footerLinks.length > 0) {
	          // Relax restrictions as no 'Cited by' prefix on author page.
	        	  citedCount = $(footerLinks[0]).text();
  	          if ($(footerLinks[0]).text &&
  	            $(footerLinks[0]).text().indexOf(CITATION_COUNT_PREFIX) >= 0) {
  	            citedCount = $(footerLinks[0]).text().substr(CITATION_COUNT_PREFIX.length)
  	          }
	
	          if ($(footerLinks[1]).text &&
	            $(footerLinks[1]).text().indexOf(RELATED_ARTICLES_PREFIX) >= 0 &&
	            $(footerLinks[1]).attr &&
	            $(footerLinks[1]).attr('href') &&
	            $(footerLinks[1]).attr('href').length > 0) {
	            relatedUrl = GOOGLE_SCHOLAR_URL_PREFIX + $(footerLinks[1]).attr('href')
	          }
	        }
	        if (authorNamesHTMLString) {
	          let cleanString = authorNamesHTMLString;
	          
	          // Check also for non-HTML ellipsis.
	          removeFromEnd(cleanString, ELLIPSIS_HTML_ENTITY, function(resultA, stringA) { 
	        	    removeFromEnd(cleanString, ELLIPSIS, function(resultB, stringB) {
	        	    	  if ( resultA ) {
	        	    	  	cleanString = stringA;
	        	    	  } else if ( resultB ) {
	        	       	cleanString = stringB;
	        	      } else if ( resultA || resultB ) {
	        	        etAl = true; 
	        	      }
	        	    	});
	        	  });
	          
	          removeFromBeginning(cleanString, ELLIPSIS_HTML_ENTITY, function(resultA, stringA) { 
	        	    removeFromBeginning(cleanString, ELLIPSIS, function(resultB, stringB) {
	        	    	  if ( resultA ) {
	        	    	  	cleanString = stringA;
	        	    	  } else if ( resultB ) {
	        	       	cleanString = stringB;
	        	      } else if ( resultA || resultB ) {
	        	        etAlBegin = true; 
	        	      }
	        	    	});
	        	  });
	          
	          let htmlAuthorNames = cleanString.split(', ')
	          if (etAl) {
	            htmlAuthorNames.push(ET_AL_NAME)
	          }
	          if (etAlBegin) {
	            htmlAuthorNames.unshift(ET_AL_NAME)
	          }
	          authors = htmlAuthorNames.map(name => {
	            let tmp = cheerio.load(name)
	            let authorObj = {
	              name: '',
	              url: ''
	            }
	            if (tmp('a').length === 0) {
	              authorObj.name = striptags(name)
	            } else {
	              authorObj.name = tmp('a').text()
	              authorObj.url = GOOGLE_SCHOLAR_URL_PREFIX + tmp('a').attr('href')
	            }
	            return authorObj
	          })
	        }
	        
	        // Profile specific.
	        if ( venueHTMLString ) {
	        	  
	          venue = venueHTMLString;
	          
            removeFromEnd(venue, ELLIPSIS_HTML_ENTITY, function(resultA, stringA) {
              removeFromEnd(venue, ELLIPSIS, function(resultB, stringB) {
                if ( resultA ) {
                  venue = stringA;
                } else if ( resultB ) {
                  venue = stringB;
                }
                removeFromEnd(venue, COMMA_HTML_ENTITY, function(resultC, stringC) { 
                  removeFromEnd(venue, COMMA, function(resultD, stringD) {
                    if ( resultC ) {
                        venue = stringC;
                      } else if ( resultD ) {
                      venue = stringD;
                    }
                  });
                });
              });
            });
	        }
	        
	        processedResults.push({
	          title: title,
	          url: url,
	          authors: authors,
	          description: description,
	          citedCount: citedCount,
	          citedUrl: citedUrl,
	          relatedUrl: relatedUrl,
	          pdf: pdfUrl,
	          year: year,
	          venue: venue
	        });
	        
	      });
	      
	      let resultsCountString = $('#gs_ab_md').text()
	      if (resultsCountString && resultsCountString.trim().length > 0) {
	        let matches = RESULT_COUNT_RE.exec(resultsCountString)
	        if (matches && matches.length > 0) {
	          resultCount = parseInt(matches[1].replace(/,/g, ''))
	        } else {
	          resultCount = processedResults.length
	        }
	      } else {
	        resultCount = processedResults.length
	      }
	
	      resolve({
	        results: processedResults,
	        count: resultCount,
	        nextUrl: nextUrl,
	        prevUrl: prevUrl,
	        next: function () {
	          let p = new Promise(function (resolve, reject) {
	            perMinThrottle(() => {
	              perSecThrottle(() => {
	                var requestOptions = {
	                  jar: true,
					  'headers': {
						'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36',
					  }
	                }
	                requestOptions.url = nextUrl
	                request(requestOptions, scholarResultsCallback(resolve, reject))
	              })
	            })
	          })
	          return p
	        },
	        previous: function () {
	          let p = new Promise(function (resolve, reject) {
	            perMinThrottle(() => {
	              perSecThrottle(() => {
	                var requestOptions = {
	                  jar: true,
					  'headers': {
						'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36',
					  }
	                }
	                requestOptions.url = prevUrl
	                request(requestOptions, scholarResultsCallback(resolve, reject))
	              })
	            })
	          })
	          return p
	        }
	      })
	   }); 
   }
  }
  
  function search (query) {
    let p = new Promise(function (resolve, reject) {
      perMinThrottle(() => {
        perSecThrottle(() => {
          var requestOptions = {
            jar: true,
			'headers': {
				'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36',
			}
          }
          requestOptions.url = encodeURI(GOOGLE_SCHOLAR_URL + query)
          request(requestOptions, scholarResultsCallback(resolve, reject, '.gs_r', '.gs_ri h3', '.gs_ri h3 a', '.gs_ri .gs_a', '.gs_ri .gs_fl a'))
        })
      })
    })
    return p
  }
  
  async function profile (id, user, yearWindow) {
    var requestOptions = {
      jar: true,
      'headers': {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36',
      }
    }
    requestOptions.url = encodeURI(GOOGLE_SCHOLAR_PROFILE_URL + id)
    let html = await promiseRequest(requestOptions);
    let n = processHtml(html, user, yearWindow);
    return n;
  }

  function all (query) {
    return search(query)
      .then(resultsObj => {
        //  eg n=111 but i have 10 already so 101 remain,
        let remainingResultsCount = resultsObj.count - resultsObj.results.length
        if (remainingResultsCount > 0) {
          //  pr = 10
          let pagesRemaining = remainingResultsCount / RESULTS_PER_PAGE
          let pageNumbers = []
          for (var i = 1; i <= pagesRemaining + 1; i++) {
            pageNumbers.push(i)
          }
          return Promise.all(pageNumbers.map(i => {
            return search(query + '&start=' + i * RESULTS_PER_PAGE)
              .then(laterPagesResultsObj => {
                return laterPagesResultsObj.results
              })
          }))
            .then(remainingResultsArr => {
              let allResults = resultsObj.results.concat(remainingResultsArr.reduce((a, b) => a.concat(b)))
              resultsObj.results = allResults
              resultsObj.nextUrl = null
              resultsObj.next = null
              resultsObj.prevUrl = null
              resultsObj.prev = null
              return resultsObj
            })
        }
      })
  }

  return {
    search: search,
    all: all,
    profile: profile,
    promiseRequest,
    parseCitationHtml    
  }
})()

module.exports = scholar
